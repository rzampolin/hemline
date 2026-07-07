/**
 * Seed loader — docs/ARCHITECTURE.md §9.3.
 *
 * Loads fixture listings WITH pre-computed extractions (so feed, filters, hem
 * indicator, similarity all work with zero API keys), one demo user
 * (5'4", sizes 6–8, soft-autumn, midi preference), and 30 synthetic swipe
 * events. Idempotent: wipes and reloads seed-owned tables on every run.
 *
 * Run `npm run db:migrate` first (or `npm run seed`, which does both).
 * Freshness offsets (lastSeenHoursAgo/firstSeenDaysAgo) are converted to
 * epoch ms at seed time so the demo feed always looks fresh.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadFixtureEntries, type FixtureEntry } from '@hemline/connectors';
import { createDb } from './client';
import { DEMO_USER_ID } from './constants';
import { contentHashFor } from './content-hash';
import {
  extractions,
  ingestRuns,
  listingImages,
  listings,
  rerankCache,
  sources,
  swipeEvents,
  userBrandSizes,
  users,
} from './schema';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');

export { DEMO_USER_ID } from './constants';
// Back-compat re-export; the canonical home is ./content-hash (side-effect-free).
export { contentHashFor } from './content-hash';

/**
 * Seed the given db file (defaults to $DATABASE_PATH relative to the repo
 * root, else <repo>/data/hemline.db). Exported so tests can seed a temp db
 * (`runSeed(tmpPath)`); running this file directly (`npm run db:seed`) still
 * seeds in place. Tables must already exist (drizzle-kit push or ensureSchema).
 */
export function runSeed(dbPathArg?: string): { dbPath: string; listingCount: number } {
  // Resolve the default db path relative to the repo root so the script works
  // from any cwd (npm -w changes cwd to the workspace dir).
  const dbPath =
    dbPathArg ??
    (process.env.DATABASE_PATH
      ? path.resolve(REPO_ROOT, process.env.DATABASE_PATH)
      : path.join(REPO_ROOT, 'data', 'hemline.db'));
  const db = createDb({ dbPath });

  const entries: FixtureEntry[] = loadFixtureEntries();
  const now = Date.now();

  // ── wipe seed-owned tables (FK-safe order) ──────────────────────────
  db.delete(swipeEvents).run();
  db.delete(userBrandSizes).run();
  db.delete(rerankCache).run();
  db.delete(extractions).run();
  db.delete(listingImages).run();
  db.delete(listings).run();
  db.delete(ingestRuns).run();
  db.delete(sources).run();
  db.delete(users).run();

  // ── sources ─────────────────────────────────────────────────────────
  db.insert(sources)
    .values([
      {
        id: 'fixture:shopify',
        kind: 'fixture',
        displayName: 'Fixtures — DTC brands (Shopify-style)',
        configJson: '{}',
        cadenceCron: '0 6 * * *',
        enabled: true,
        lastRunAt: now,
        etagJson: '{}',
      },
      {
        id: 'fixture:ebay',
        kind: 'fixture',
        displayName: 'Fixtures — resale (eBay-style)',
        configJson: '{}',
        cadenceCron: '0 */6 * * *',
        enabled: true,
        lastRunAt: now,
        etagJson: '{}',
      },
    ])
    .run();

  // ── listings + images + pre-baked extractions ───────────────────────
  let imageCount = 0;
  const listingIds: string[] = [];
  for (const entry of entries) {
    const raw = entry.raw;
    const id = `${raw.sourceId}:${raw.sourceListingId}`;
    listingIds.push(id);
    const hash = contentHashFor(raw);
    const lastSeenAt = now - Math.round(entry.lastSeenHoursAgo * 3_600_000);
    const firstSeenAt = lastSeenAt - Math.round(entry.firstSeenDaysAgo * 86_400_000);

    db.insert(listings)
      .values({
        id,
        sourceId: raw.sourceId,
        sourceListingId: raw.sourceListingId,
        sourceUrl: raw.sourceUrl,
        affiliateUrl: raw.affiliateUrl ?? null,
        title: raw.title,
        description: raw.description ?? null,
        brand: raw.brand ?? null,
        priceCents: raw.priceCents,
        currency: raw.currency,
        condition: raw.condition ?? 'unknown',
        isVintage: raw.isVintage ?? false,
        era: raw.era ?? null,
        sizeLabelsJson: JSON.stringify(raw.sizeLabels),
        sizeNormalizedJson: JSON.stringify(entry.sizeNormalized),
        availabilityJson: JSON.stringify(raw.availability ?? {}),
        contentHash: hash,
        firstSeenAt,
        lastSeenAt,
        removedAt: null,
      })
      .run();

    db.insert(listingImages)
      .values(raw.imageUrls.map((url, position) => ({ listingId: id, url, position })))
      .run();
    imageCount += raw.imageUrls.length;

    const x = entry.extraction;
    db.insert(extractions)
      .values({
        contentHash: hash,
        listingId: id,
        model: 'fixture',
        lengthClass: x.lengthClass,
        lengthInches: x.lengthInches,
        measurementsJson: JSON.stringify(x.measurements),
        colorsJson: JSON.stringify(x.colors),
        fabric: x.fabric,
        neckline: x.neckline,
        silhouette: x.silhouette,
        sleeve: x.sleeve,
        pattern: x.pattern,
        occasionJson: JSON.stringify(x.occasions),
        attributeVectorJson: JSON.stringify(x.attributeVector),
        extractionConfidence: x.confidence,
        extractedAt: lastSeenAt,
        rawResponseJson: null,
      })
      .run();
  }

  // ── demo user: 5'4", sizes 6–8, soft autumn, midi preference ────────
  db.insert(users)
    .values({
      id: DEMO_USER_ID,
      createdAt: now - 14 * 86_400_000,
      heightInches: 64,
      heelPrefInches: 0,
      sizesJson: JSON.stringify([6, 8]),
      measurementsJson: JSON.stringify({ bust: 35, waist: 28, hip: 38 }),
      lengthPrefsJson: JSON.stringify(['knee', 'below_knee', 'mid_calf']),
      coveragePrefsJson: JSON.stringify({}),
      budgetMinCents: 3000,
      budgetMaxCents: 25000,
      colorSeason: 'soft_autumn',
      paletteJson: JSON.stringify([
        { hex: '#B7410E', name: 'rust' },
        { hex: '#C08552', name: 'camel' },
        { hex: '#808000', name: 'olive' },
        { hex: '#9CAF88', name: 'sage' },
        { hex: '#E2725B', name: 'terracotta' },
        { hex: '#C9A66B', name: 'soft gold' },
        { hex: '#8E7CC3', name: 'dusty lilac' },
        { hex: '#A0522D', name: 'sienna' },
        { hex: '#D8C3A5', name: 'oat' },
        { hex: '#6B4226', name: 'chocolate' },
      ]),
      styleTagsJson: JSON.stringify({
        'silhouette:wrap': 0.9,
        'silhouette:a_line': 0.7,
        'length:midi': 1,
        'length:mid_calf': 0.6,
        'color:orange': 0.8,
        'color:green': 0.6,
        'color:brown': 0.5,
        'pattern:floral': 0.7,
        'fabric:linen': 0.5,
        'vibe:romantic': 0.6,
        'occasion:wedding_guest': 0.4,
        'silhouette:bodycon': -0.7,
        'length:micro': -0.9,
      }),
      onboardedAt: now - 14 * 86_400_000,
    })
    .run();

  db.insert(userBrandSizes)
    .values([
      { userId: DEMO_USER_ID, brand: 'Reformation', sizeLabel: '8' },
      { userId: DEMO_USER_ID, brand: 'STAUD', sizeLabel: 'M' },
      { userId: DEMO_USER_ID, brand: 'Free People', sizeLabel: 'S' },
    ])
    .run();

  // ── 30 synthetic swipe events (first 15 = calibration deck) ─────────
  const verdictCycle = ['like', 'like', 'dislike', 'skip', 'like', 'save', 'dislike', 'like'];
  db.insert(swipeEvents)
    .values(
      listingIds.slice(0, 30).map((listingId, i) => ({
        userId: DEMO_USER_ID,
        listingId,
        verdict: verdictCycle[i % verdictCycle.length],
        context: i < 15 ? 'calibration' : 'feed',
        createdAt: now - (30 - i) * 60_000,
      })),
    )
    .run();

  console.log(`[seed] db: ${dbPath}`);
  console.log(
    `[seed] loaded ${entries.length} listings, ${imageCount} images, ${entries.length} extractions, 2 sources, 1 demo user, 30 swipes`,
  );
  return { dbPath, listingCount: entries.length };
}

// Self-execute only when run as a script (tsx packages/db/src/seed.ts),
// not when imported by tests/route code.
const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runSeed();
