/**
 * Derives the frontend mock dataset from the canonical fixture corpus
 * (packages/connectors/src/fixtures/listings.json) so mock mode looks real
 * and stays in sync with what the seeded DB will serve.
 *
 * Output: apps/web/lib/mock/mock-listings.json
 *   [{ listing: <Listing minus timestamps>, lastSeenHoursAgo, firstSeenDaysAgo, attributeVector }]
 *
 * - Timestamps are stored as offsets; the mock layer converts to epoch ms at
 *   module load so freshness badges ("Seen 2h ago") always look live.
 * - placehold.co image URLs are rewritten to a compact `mockimg:` scheme the
 *   client resolves into inline SVG editorial placeholders (offline, fast,
 *   deterministic for e2e). Real http(s) URLs pass through untouched.
 *
 * Run: node apps/web/scripts/derive-mock-listings.mjs   (idempotent, committed output)
 */
/* global console, URLSearchParams */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(here, '../../../packages/connectors/src/fixtures/listings.json');
const outPath = join(here, '../lib/mock/mock-listings.json');

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const NEUTRAL = { hex: '#A89B8C', family: 'brown' };

function mockImageUrl(entry, i) {
  const { raw, extraction } = entry;
  const c0 = extraction.colors[0] ?? NEUTRAL;
  const c1 = extraction.colors[1] ?? c0;
  const label = raw.brand ?? 'One of a kind';
  const params = new URLSearchParams({
    i: String(i),
    c0: (c0.hex ?? NEUTRAL.hex).replace('#', ''),
    c1: (c1.hex ?? c0.hex ?? NEUTRAL.hex).replace('#', ''),
    len: extraction.lengthClass ?? 'midi',
    sil: extraction.silhouette ?? 'a_line',
    b: label,
  });
  return `mockimg:${params.toString()}`;
}

const out = fixtures.map((entry) => {
  const { raw, extraction } = entry;
  return {
    listing: {
      id: `${raw.sourceId}:${raw.sourceListingId}`,
      sourceId: raw.sourceId,
      sourceUrl: raw.sourceUrl,
      affiliateUrl: raw.affiliateUrl ?? null,
      title: raw.title,
      brand: raw.brand ?? null,
      priceCents: raw.priceCents,
      currency: raw.currency,
      images: raw.imageUrls.map((u, i) =>
        u.startsWith('https://placehold.co') ? mockImageUrl(entry, i) : u,
      ),
      sizeLabels: raw.sizeLabels,
      sizeNormalized: entry.sizeNormalized,
      availability: raw.availability ?? {},
      condition: raw.condition ?? 'unknown',
      isVintage: raw.isVintage ?? false,
      era: raw.era ?? null,
      colors: extraction.colors,
      lengthClass: extraction.lengthClass,
      lengthInches: extraction.lengthInches,
      measurements: extraction.measurements,
      fabric: extraction.fabric,
      neckline: extraction.neckline,
      silhouette: extraction.silhouette,
      extractionConfidence: extraction.confidence,
    },
    lastSeenHoursAgo: entry.lastSeenHoursAgo,
    firstSeenDaysAgo: entry.firstSeenDaysAgo,
    attributeVector: extraction.attributeVector,
  };
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${out.length} mock listings → ${outPath}`);
