/**
 * Fixtures connector + fixture loader — docs/ARCHITECTURE.md §8.
 *
 * ~150 curated listings (JSON) spanning every silhouette/length/price band
 * WITH pre-baked extractions: the zero-key demo dataset and the test corpus.
 * `packages/db/src/seed.ts` loads them via `loadFixtureEntries()`.
 *
 * Regenerate deterministically: `node scripts/generate-fixtures.mjs`
 */
import type {
  ExtractedAttributes,
  FetchContext,
  FetchResult,
  RawListing,
  SourceConnector,
} from '@hemline/contracts';
// Static JSON import (not fs + import.meta.url): survives the Next server
// bundle where import.meta.url is not a file:// URL (integration 2026-07-06).
import listingsJson from './listings.json';

export interface FixtureEntry {
  raw: RawListing;
  /** pre-normalized US numeric sizes (real normalizer is data-eng's) */
  sizeNormalized: number[];
  /** freshness offsets — seed converts to epoch ms at seed time so demo data stays fresh */
  lastSeenHoursAgo: number;
  firstSeenDaysAgo: number;
  /** pre-baked extraction (extractions.model = 'fixture') */
  extraction: ExtractedAttributes;
}

export function loadFixtureEntries(): FixtureEntry[] {
  // structuredClone: callers may mutate entries; keep the module object pristine
  // (fs.readFileSync used to hand out a fresh copy per call).
  return structuredClone(listingsJson) as unknown as FixtureEntry[];
}

export const fixturesConnector: SourceConnector = {
  id: 'fixtures',
  kind: 'fixture',
  defaultCadence: '0 6 * * *',
  isConfigured(): boolean {
    return true;
  },
  async fetchListings(_ctx: FetchContext): Promise<FetchResult> {
    const now = Date.now();
    const listings = loadFixtureEntries().map((e) => ({
      ...e.raw,
      seenAt: now - Math.round(e.lastSeenHoursAgo * 3_600_000),
    }));
    return { listings, stats: { fetched: listings.length, errors: 0 } };
  },
};
