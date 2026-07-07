import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchResult, Logger, RawListing, SourceConnector } from '@hemline/contracts';
import { createEbayConnector } from '@hemline/connectors';
import { ingestRuns, listingImages, listings, sources, type Db } from '@hemline/db';
import { contentHashFor, runPipeline } from './pipeline';
import { cronIntervalMs, pruneStale } from './freshness';
import { createTestDb } from './testing/test-db';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function rawListing(over: Partial<RawListing> = {}): RawListing {
  return {
    sourceId: 'test-src',
    sourceListingId: 'A',
    sourceUrl: 'https://example.com/a',
    title: 'Linen Midi Dress',
    description: 'A breezy linen midi.',
    brand: 'Testbrand',
    priceCents: 12300,
    currency: 'USD',
    imageUrls: ['https://cdn/a1.jpg', 'https://cdn/a2.jpg'],
    sizeLabels: ['S', 'M'],
    availability: { S: true, M: true },
    condition: 'new',
    isVintage: false,
    seenAt: 1_000,
    ...over,
  };
}

function fakeConnector(
  fetchResults: (FetchResult | Error)[],
  over: Partial<SourceConnector> = {},
): SourceConnector {
  let call = 0;
  return {
    id: 'test-src',
    kind: 'test',
    defaultCadence: '0 6 * * *',
    isConfigured: () => true,
    async fetchListings() {
      const r = fetchResults[Math.min(call++, fetchResults.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    ...over,
  };
}

let db: Db;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = createTestDb()));
afterEach(() => cleanup());

// prune disabled: fixture seenAt values are tiny epochs that would instantly stale out
const opts = { logger: silent, extract: false, prune: false } as const;

describe('runPipeline upsert semantics', () => {
  it('inserts new listings with images and records run + source bookkeeping', async () => {
    const a = rawListing();
    const b = rawListing({ sourceListingId: 'B', title: 'Silk Slip', imageUrls: ['https://cdn/b.jpg'] });
    const connector = fakeConnector([{ listings: [a, b], stats: { fetched: 2, errors: 0 } }]);

    const result = await runPipeline(db, connector, opts);

    expect(result.status).toBe('ok');
    expect(result.stats).toMatchObject({ fetched: 2, new: 2, updated: 0, unchanged: 0, errors: 0 });

    const rows = db.select().from(listings).all();
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.id === 'test-src:A')!;
    expect(rowA).toMatchObject({
      sourceId: 'test-src',
      title: 'Linen Midi Dress',
      priceCents: 12300,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      removedAt: null,
      contentHash: contentHashFor(a),
    });
    expect(JSON.parse(rowA.availabilityJson)).toEqual({ S: true, M: true });

    const images = db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, 'test-src:A'))
      .all();
    expect(images.map((i) => [i.url, i.position])).toEqual([
      ['https://cdn/a1.jpg', 0],
      ['https://cdn/a2.jpg', 1],
    ]);

    // health bookkeeping (admin G1 reads these)
    const src = db.select().from(sources).where(eq(sources.id, 'test-src')).get()!;
    expect(src.kind).toBe('test');
    expect(src.lastRunAt).not.toBeNull();
    const run = db.select().from(ingestRuns).where(eq(ingestRuns.id, result.runId)).get()!;
    expect(run.status).toBe('ok');
    expect(JSON.parse(run.statsJson)).toMatchObject({ new: 2 });
  });

  it('bumps last_seen_at (and availability) on unchanged re-sightings', async () => {
    const first = rawListing();
    const again = rawListing({ seenAt: 5_000, availability: { S: false, M: true } });
    const connector = fakeConnector([
      { listings: [first], stats: { fetched: 1, errors: 0 } },
      { listings: [again], stats: { fetched: 1, errors: 0 } },
    ]);

    await runPipeline(db, connector, opts);
    const result = await runPipeline(db, connector, opts);

    expect(result.stats).toMatchObject({ new: 0, updated: 0, unchanged: 1 });
    const row = db.select().from(listings).where(eq(listings.id, 'test-src:A')).get()!;
    expect(row.lastSeenAt).toBe(5_000);
    expect(row.firstSeenAt).toBe(1_000); // preserved
    expect(row.contentHash).toBe(contentHashFor(first)); // availability not hashed
    expect(JSON.parse(row.availabilityJson)).toEqual({ S: false, M: true });
  });

  it('updates fields, content_hash, and images when content changed', async () => {
    const v1 = rawListing();
    const v2 = rawListing({
      seenAt: 5_000,
      priceCents: 9900,
      imageUrls: ['https://cdn/a2.jpg', 'https://cdn/a3.jpg'],
    });
    const connector = fakeConnector([
      { listings: [v1], stats: { fetched: 1, errors: 0 } },
      { listings: [v2], stats: { fetched: 1, errors: 0 } },
    ]);

    await runPipeline(db, connector, opts);
    const result = await runPipeline(db, connector, opts);

    expect(result.stats).toMatchObject({ new: 0, updated: 1, unchanged: 0 });
    const row = db.select().from(listings).where(eq(listings.id, 'test-src:A')).get()!;
    expect(row.priceCents).toBe(9900);
    expect(row.lastSeenAt).toBe(5_000);
    expect(row.contentHash).toBe(contentHashFor(v2));
    expect(row.contentHash).not.toBe(contentHashFor(v1));

    const images = db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, 'test-src:A'))
      .all();
    expect(images.map((i) => i.url)).toEqual(['https://cdn/a2.jpg', 'https://cdn/a3.jpg']);
  });

  it('soft-removes explicitly-gone listings and revives them when re-seen', async () => {
    const a = rawListing();
    const connector = fakeConnector([
      { listings: [a], stats: { fetched: 1, errors: 0 } },
      { listings: [], stats: { fetched: 0, errors: 0 }, removedSourceListingIds: ['A'] },
      { listings: [{ ...a, seenAt: 9_000 }], stats: { fetched: 1, errors: 0 } },
    ]);

    await runPipeline(db, connector, opts);
    const removedRun = await runPipeline(db, connector, { ...opts, prune: false });
    expect(removedRun.stats.removed).toBe(1);
    let row = db.select().from(listings).where(eq(listings.id, 'test-src:A')).get()!;
    expect(row.removedAt).not.toBeNull();

    const revivedRun = await runPipeline(db, connector, opts);
    expect(revivedRun.stats.unchanged).toBe(1);
    row = db.select().from(listings).where(eq(listings.id, 'test-src:A')).get()!;
    expect(row.removedAt).toBeNull();
  });

  it('records an error run (and never throws) when fetch fails', async () => {
    const connector = fakeConnector([new Error('store on fire')]);
    const result = await runPipeline(db, connector, opts);
    expect(result.status).toBe('error');
    const run = db.select().from(ingestRuns).where(eq(ingestRuns.id, result.runId)).get()!;
    expect(run.status).toBe('error');
    expect(run.error).toContain('store on fire');
    expect(run.finishedAt).not.toBeNull();
  });

  it('drops schema-invalid raw listings as errors without failing the run', async () => {
    const bad = { ...rawListing({ sourceListingId: 'BAD' }), priceCents: -5 } as RawListing;
    const connector = fakeConnector([
      { listings: [rawListing(), bad], stats: { fetched: 2, errors: 0 } },
    ]);
    const result = await runPipeline(db, connector, opts);
    expect(result.status).toBe('ok');
    expect(result.stats).toMatchObject({ new: 1, errors: 1 });
    expect(db.select().from(listings).all()).toHaveLength(1);
  });

  it('creates sources rows for sub-source ids (fixtures pattern)', async () => {
    const connector = fakeConnector(
      [
        {
          listings: [
            rawListing({ sourceId: 'fixture:shopify' }),
            rawListing({ sourceId: 'fixture:ebay', sourceListingId: 'E1' }),
          ],
          stats: { fetched: 2, errors: 0 },
        },
      ],
      { id: 'fixtures', kind: 'fixture' },
    );
    const result = await runPipeline(db, connector, opts);
    expect(result.stats.new).toBe(2);
    const ids = db
      .select({ id: sources.id })
      .from(sources)
      .all()
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(['fixture:ebay', 'fixture:shopify', 'fixtures']);
  });
});

describe('freshness', () => {
  it('cronIntervalMs approximates the cadences we schedule', () => {
    expect(cronIntervalMs('0 6 * * *')).toBe(24 * 3_600_000);
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * 3_600_000);
    expect(cronIntervalMs('*/30 * * * *')).toBe(30 * 60_000);
    expect(cronIntervalMs('garbage')).toBe(24 * 3_600_000);
  });

  it('prunes listings unseen for 2× cadence via the pipeline', async () => {
    const now = Date.now();
    const stale = rawListing({ sourceListingId: 'STALE', seenAt: now - 3 * 24 * 3_600_000 });
    const fresh = rawListing({ sourceListingId: 'FRESH', seenAt: now });
    const connector = fakeConnector([
      { listings: [stale, fresh], stats: { fetched: 2, errors: 0 } },
      { listings: [fresh], stats: { fetched: 1, errors: 0 } }, // STALE missing from crawl
    ]);

    await runPipeline(db, connector, { ...opts, now }); // seed without pruning
    const result = await runPipeline(db, connector, { ...opts, now, prune: true });

    expect(result.stats.pruned).toBe(1); // daily cadence → 48h window
    const staleRow = db.select().from(listings).where(eq(listings.id, 'test-src:STALE')).get()!;
    const freshRow = db.select().from(listings).where(eq(listings.id, 'test-src:FRESH')).get()!;
    expect(staleRow.removedAt).toBe(now);
    expect(freshRow.removedAt).toBeNull();
  });

  it('pruneStale respects an explicit window and already-removed rows', async () => {
    const now = Date.now();
    const connector = fakeConnector([
      {
        listings: [rawListing({ seenAt: now - 10_000 })],
        stats: { fetched: 1, errors: 0 },
      },
    ]);
    await runPipeline(db, connector, { ...opts, now });

    expect(pruneStale(db, ['test-src'], '0 6 * * *', { now, staleAfterMs: 60_000 })).toBe(0);
    expect(pruneStale(db, ['test-src'], '0 6 * * *', { now, staleAfterMs: 5_000 })).toBe(1);
    // second pass: nothing left to prune
    expect(pruneStale(db, ['test-src'], '0 6 * * *', { now, staleAfterMs: 5_000 })).toBe(0);
  });
});

describe('eBay mock mode through the pipeline', () => {
  it('ingests the recorded sample and flags the run as mock', async () => {
    const connector = createEbayConnector({ env: {} as NodeJS.ProcessEnv });
    const result = await runPipeline(db, connector, { ...opts, env: {} as NodeJS.ProcessEnv });

    expect(result.status).toBe('ok');
    expect(result.stats.mock).toBe(true);
    expect(result.stats.new).toBe(20);

    const run = db.select().from(ingestRuns).where(eq(ingestRuns.id, result.runId)).get()!;
    expect(JSON.parse(run.statsJson)).toMatchObject({ mock: true, new: 20 });

    const rows = db.select().from(listings).where(eq(listings.sourceId, 'ebay')).all();
    expect(rows).toHaveLength(20);

    // idempotent re-run: everything unchanged
    const again = await runPipeline(db, connector, { ...opts, env: {} as NodeJS.ProcessEnv });
    expect(again.stats).toMatchObject({ new: 0, unchanged: 20 });
  });
});
