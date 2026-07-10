/**
 * Kids-listing purge (founder bug 2026-07-09): heuristic scan report,
 * dry-run/apply/idempotence, and the budget-guarded vision recheck — all on a
 * temp db (never live data).
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudienceChecker, AudienceCheckInput, AudienceCheckResult } from '@hemline/ai';
import { extractions, listingImages, listings, sources, type Db } from '@hemline/db';
import {
  findVisionSuspects,
  formatPurgeReport,
  purgeKids,
  recheckVision,
  scanKidsListings,
  VISION_COST_PER_CALL_USD,
} from './purge-kids';
import { createTestDb } from './testing/test-db';

let db: Db;
let cleanup: () => void;

function addListing(
  id: string,
  sourceId: string,
  title: string,
  sizeLabels: string[],
  opts: { removed?: boolean; extractionAudience?: 'adult' | 'child' | null | 'none'; image?: boolean } = {},
): void {
  db.insert(listings)
    .values({
      id,
      sourceId,
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title,
      priceCents: 10000,
      currency: 'USD',
      sizeLabelsJson: JSON.stringify(sizeLabels),
      sizeNormalizedJson: '[]',
      contentHash: `hash-${id}`,
      firstSeenAt: 1,
      lastSeenAt: 2,
      removedAt: opts.removed ? 3 : null,
    })
    .run();
  if (opts.image !== false) {
    db.insert(listingImages)
      .values({ listingId: id, url: `https://cdn.example.com/${id}.jpg`, position: 0 })
      .run();
  }
  if (opts.extractionAudience !== 'none') {
    db.insert(extractions)
      .values({
        contentHash: `hash-${id}`,
        listingId: id,
        model: 'mock',
        audience: opts.extractionAudience ?? null,
        extractedAt: 4,
      })
      .run();
  }
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  cleanup = t.cleanup;
  for (const id of [
    'shopify:doen.test',
    'shopify:lsf.test',
    'shopify:adult.test',
    'shopify:selkie.test',
    'shopify:motel.test',
  ]) {
    db.insert(sources)
      .values({ id, kind: 'shopify', displayName: id, cadenceCron: '0 6 * * *' })
      .run();
  }
});

afterEach(() => cleanup());

function seedCatalog(): void {
  // heuristic-flaggable kid items
  addListing('lsf-girls', 'shopify:lsf.test', 'Girls Decker Cotton Floral Dress', [
    '2/3', '3/4', '4/5', '5/6', '7/8', '8/9', '10', '12', '14',
  ]);
  addListing('lsf-toddler', 'shopify:lsf.test', 'Toddler Twirl Dress', ['2T', '3T', '4T']);
  // the Dôen case: no text signal, adult-looking sizes → vision suspect
  addListing('doen-lucy', 'shopify:doen.test', 'LUCY DRESS -- AMBLE PLAID', ['2', '4', '6', '8', '10']);
  // adult keepers (traps)
  addListing('adult-babydoll', 'shopify:adult.test', 'Babydoll Mini Dress', ['XS', 'S', 'M']);
  addListing('adult-babyblue', 'shopify:adult.test', 'Baby Blue Midi Dress', ['2', '4', '6']);
  addListing('adult-girlsnight', 'shopify:adult.test', 'Girls Night Out Dress', ['S', 'M']);
  // already removed kid item — never rescanned
  addListing('gone-kid', 'shopify:lsf.test', 'Kids Party Dress', ['4Y'], { removed: true });
  // Dôen adult dress with a verdict already stored → not a suspect
  addListing('doen-adult', 'shopify:doen.test', 'ISCHIA DRESS -- SALT', ['2', '4', '6'], {
    extractionAudience: 'adult',
  });
}

describe('scanKidsListings — heuristic report', () => {
  it('flags kid items per store with reasons, keeps the adult traps', () => {
    seedCatalog();
    const report = scanKidsListings(db);
    expect(report.flagged.map((f) => f.listingId).sort()).toEqual(['lsf-girls', 'lsf-toddler']);
    expect(report.perStore['shopify:lsf.test'].count).toBe(2);
    expect(report.perStore['shopify:lsf.test'].sampleTitles[0]).toMatch(/Girls Decker/);
    expect(report.perStore['shopify:adult.test']).toBeUndefined();
  });
});

describe('purgeKids — vision verdict outranks keyword flags (prod false positives 2026-07-09)', () => {
  it('keyword-flagged listings with audience=adult are cleared, reported, never removed', () => {
    seedCatalog();
    // Selkie-style name-copy false positive: matches a child keyword BUT
    // vision has already said adult. (Use "children" — "Baby Soft"/"Star
    // Child" themselves are now guarded at the regex level.)
    addListing('selkie-fp', 'shopify:selkie.test', 'The Children of Flowers Gown', ['XS', 'S', 'M'], {
      extractionAudience: 'adult',
    });
    const report = purgeKids(db, { apply: true });
    expect(report.visionCleared.map((f) => f.listingId)).toEqual(['selkie-fp']);
    expect(report.flagged).toBe(2); // only the two genuine kid items
    const still = db.select({ id: listings.id }).from(listings).where(sql`removed_at IS NULL AND id = 'selkie-fp'`).all();
    expect(still).toHaveLength(1); // never removed
    expect(formatPurgeReport(report)).toContain('CLEARED by vision');
  });

  it('regex guards: Selkie "Baby Soft"/"Baby Banana" and Motel "Star Child" never flag at all', () => {
    seedCatalog();
    addListing('selkie-soft', 'shopify:selkie.test', 'The Baby Soft Cake Shop Dress', ['XS', 'S', 'M', '1X']);
    addListing('selkie-banana', 'shopify:selkie.test', 'The Baby Banana Puff Dress', ['XS', 'S']);
    addListing('motel-star', 'shopify:motel.test', 'Malina Dress in Star Child Glitter Net', ['S', 'M']);
    const report = scanKidsListings(db);
    const ids = report.flagged.map((f) => f.listingId);
    expect(ids).not.toContain('selkie-soft');
    expect(ids).not.toContain('selkie-banana');
    expect(ids).not.toContain('motel-star');
  });
});

describe('purgeKids — dry-run / apply / idempotence', () => {
  it('dry-run reports but removes nothing', () => {
    seedCatalog();
    const result = purgeKids(db, { apply: false });
    expect(result.flagged).toBe(2);
    expect(result.removed).toBe(0);
    const active = db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM listings WHERE removed_at IS NULL`,
    );
    expect(active[0].n).toBe(7);
    expect(formatPurgeReport(result)).toContain('DRY RUN');
  });

  it('--apply soft-deletes (removed_at) and records the verdict on extraction rows', () => {
    seedCatalog();
    const result = purgeKids(db, { apply: true, now: 999 });
    expect(result.removed).toBe(2);
    const rows = db.all<{ id: string; removed_at: number | null }>(
      sql`SELECT id, removed_at FROM listings WHERE id IN ('lsf-girls','lsf-toddler')`,
    );
    expect(rows.every((r) => r.removed_at === 999)).toBe(true);
    const aud = db.all<{ audience: string | null }>(
      sql`SELECT audience FROM extractions WHERE listing_id = 'lsf-girls'`,
    );
    expect(aud[0].audience).toBe('child');
    // adult keepers untouched
    const keepers = db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM listings WHERE removed_at IS NULL AND source_id = 'shopify:adult.test'`,
    );
    expect(keepers[0].n).toBe(3);
  });

  it('is idempotent: a second --apply run flags and removes 0', () => {
    seedCatalog();
    purgeKids(db, { apply: true });
    const second = purgeKids(db, { apply: true });
    expect(second.flagged).toBe(0);
    expect(second.removed).toBe(0);
  });
});

function fakeChecker(
  verdicts: Record<string, 'adult' | 'child' | null>,
  costPerCall = VISION_COST_PER_CALL_USD,
): AudienceChecker & { calls: string[] } {
  const calls: string[] = [];
  const stats = { calls: 0, child: 0, adult: 0, undecided: 0, imageUnavailable: 0, failed: 0 };
  return {
    mode: 'live' as const,
    calls,
    stats,
    costUsd: () => stats.calls * costPerCall,
    async checkOne(input: AudienceCheckInput): Promise<AudienceCheckResult> {
      calls.push(input.title);
      stats.calls += 1;
      const audience = verdicts[input.title] ?? null;
      return { status: 'classified', audience, modelConfidence: 0.9 };
    },
  };
}

describe('vision recheck — suspects, verdict persistence, budget guard', () => {
  it('suspect pool: known-kids-line stores, no audience verdict, not heuristic-flagged', () => {
    seedCatalog();
    const suspects = findVisionSuspects(db, ['shopify:doen.test', 'shopify:lsf.test']);
    // lsf-girls/lsf-toddler are heuristic-flagged (pass 1 handles them free);
    // doen-adult already has a verdict; gone-kid is removed → only LUCY remains
    expect(suspects.map((s) => s.listingId)).toEqual(['doen-lucy']);
    expect(suspects[0].primaryImageUrl).toBe('https://cdn.example.com/doen-lucy.jpg');
  });

  it('child verdict persists to extractions and soft-deletes under --apply', async () => {
    seedCatalog();
    const checker = fakeChecker({ 'LUCY DRESS -- AMBLE PLAID': 'child' });
    const suspects = findVisionSuspects(db, ['shopify:doen.test']);
    const result = await recheckVision(db, suspects, checker, { apply: true, budgetUsd: 1, now: 777 });
    expect(result).toMatchObject({ checked: 1, child: 1, adult: 0, removed: 1 });
    const row = db.all<{ removed_at: number | null; audience: string | null }>(
      sql`SELECT l.removed_at, e.audience FROM listings l JOIN extractions e ON e.listing_id = l.id WHERE l.id = 'doen-lucy'`,
    );
    expect(row[0]).toEqual({ removed_at: 777, audience: 'child' });
  });

  it('dry-run persists the paid verdict but does NOT remove; the listing leaves the suspect pool', async () => {
    seedCatalog();
    const checker = fakeChecker({ 'LUCY DRESS -- AMBLE PLAID': 'child' });
    const suspects = findVisionSuspects(db, ['shopify:doen.test']);
    const result = await recheckVision(db, suspects, checker, { apply: false, budgetUsd: 1 });
    expect(result).toMatchObject({ checked: 1, child: 1, removed: 0 });
    const row = db.all<{ removed_at: number | null }>(
      sql`SELECT removed_at FROM listings WHERE id = 'doen-lucy'`,
    );
    expect(row[0].removed_at).toBeNull();
    // verdict stored → never re-billed
    expect(findVisionSuspects(db, ['shopify:doen.test'])).toEqual([]);
  });

  it('budget guard caps the number of calls upfront', async () => {
    seedCatalog();
    // three extra Dôen suspects
    for (const id of ['d1', 'd2', 'd3']) {
      addListing(id, 'shopify:doen.test', `DRESS ${id}`, ['2', '4']);
    }
    const checker = fakeChecker({});
    const suspects = findVisionSuspects(db, ['shopify:doen.test']);
    expect(suspects).toHaveLength(4);
    // budget covers exactly 2 calls
    const result = await recheckVision(db, suspects, checker, {
      apply: false,
      budgetUsd: 2 * VISION_COST_PER_CALL_USD,
    });
    expect(checker.calls.length).toBeLessThanOrEqual(2);
    expect(result.skippedForBudget).toBeGreaterThanOrEqual(2);
  });

  it('suspects without a primary image are reported, not billed', async () => {
    addListing('no-img', 'shopify:doen.test', 'MYSTERY DRESS', ['2', '4'], { image: false });
    const checker = fakeChecker({});
    const suspects = findVisionSuspects(db, ['shopify:doen.test']);
    const result = await recheckVision(db, suspects, checker, { apply: false, budgetUsd: 1 });
    expect(checker.calls).toHaveLength(0);
    expect(result.imageUnavailable).toBe(1);
  });
});
