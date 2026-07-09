import { describe, expect, it } from 'vitest';
import type { Listing } from '@hemline/contracts';
import {
  applyHardFilters,
  CANDIDATE_CAP,
  matchesHardFilters,
  matchesQuery,
  measurementsFit,
  sizeCompatible,
  stratifiedCap,
} from './filters';

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'fixture:test:1',
    sourceId: 'fixture:shopify',
    sourceUrl: 'https://example.com/1',
    affiliateUrl: null,
    title: 'Silk Midi Dress',
    brand: 'Reformation',
    priceCents: 15000,
    currency: 'USD',
    images: [],
    sizeLabels: ['6', '8'],
    sizeNormalized: [6, 8],
    availability: {},
    condition: 'new',
    isVintage: false,
    era: null,
    colors: [{ name: 'navy', family: 'blue', hex: '#000080' }],
    lengthClass: 'midi',
    lengthInches: 44,
    measurements: { bust: null, waist: null, hip: null, length: 44 },
    fabric: 'silk',
    neckline: 'v_neck',
    silhouette: 'slip',
    extractionConfidence: 0.9,
    lastSeenAt: 1_700_000_000_000,
    firstSeenAt: 1_690_000_000_000,
    ...overrides,
  };
}

describe('sizeCompatible — labels', () => {
  it('matches when a normalized size intersects', () => {
    expect(sizeCompatible(listing(), [8, 10])).toBe(true);
    expect(sizeCompatible(listing(), [12])).toBe(false);
  });

  it('empty user sizes match everything', () => {
    expect(sizeCompatible(listing(), [])).toBe(true);
  });

  it('a listing with no size info is not excluded (unknown ≠ no)', () => {
    expect(sizeCompatible(listing({ sizeNormalized: [] }), [8])).toBe(true);
  });
});

describe('sizeCompatible — vintage weak prior (doc §5)', () => {
  const vintage12 = listing({
    isVintage: true,
    era: '1970s',
    sizeNormalized: [12],
    measurements: { bust: null, waist: null, hip: null, length: null },
  });

  it('vintage "12" matches modern 6–10', () => {
    expect(sizeCompatible(vintage12, [6])).toBe(true);
    expect(sizeCompatible(vintage12, [8])).toBe(true);
    expect(sizeCompatible(vintage12, [10])).toBe(true);
  });

  it('vintage "12" does NOT match a modern 12 or a modern 4', () => {
    expect(sizeCompatible(vintage12, [12])).toBe(false);
    expect(sizeCompatible(vintage12, [4])).toBe(false);
  });

  it('measurements beat the vintage label when both sides have them', () => {
    const measured = listing({
      isVintage: true,
      sizeNormalized: [12], // label alone would exclude a modern 12
      silhouette: 'sheath',
      measurements: { bust: 42, waist: null, hip: null, length: null },
    });
    // body bust 40 + ease 1.5 + slack 2 = 43.5 ≥ garment 42 ≥ 39 → fits
    expect(sizeCompatible(measured, [12], { bust: 40, waist: null, hip: null })).toBe(true);
  });
});

describe('measurementsFit — silhouette ease table', () => {
  it('bodycon (+1″ ease): garment must sit close to body', () => {
    const l = listing({ silhouette: 'bodycon', measurements: { bust: 37, waist: null, hip: null, length: null } });
    // window: 36−1 … 36+1+2 = 35…39
    expect(measurementsFit(l, { bust: 36, waist: null, hip: null })).toBe(true);
    const tooBig = listing({ silhouette: 'bodycon', measurements: { bust: 40, waist: null, hip: null, length: null } });
    expect(measurementsFit(tooBig, { bust: 36, waist: null, hip: null })).toBe(false);
  });

  it('tent (+4″ ease) accepts a much roomier garment', () => {
    const l = listing({ silhouette: 'tent', measurements: { bust: 41, waist: null, hip: null, length: null } });
    expect(measurementsFit(l, { bust: 36, waist: null, hip: null })).toBe(true);
  });

  it('too small fails regardless of silhouette', () => {
    const l = listing({ silhouette: 'tent', measurements: { bust: 34, waist: null, hip: null, length: null } });
    expect(measurementsFit(l, { bust: 36, waist: null, hip: null })).toBe(false);
  });

  it('every comparable pair must fit (bust ok, waist too small → no)', () => {
    const l = listing({
      silhouette: 'sheath',
      measurements: { bust: 38, waist: 26, hip: null, length: null },
    });
    expect(measurementsFit(l, { bust: 36, waist: 28, hip: null })).toBe(false);
  });

  it('returns null when no pair is comparable', () => {
    const l = listing({ measurements: { bust: 38, waist: null, hip: null, length: null } });
    expect(measurementsFit(l, { bust: null, waist: 28, hip: null })).toBeNull();
  });

  it('null silhouette falls back to the generic ease', () => {
    const l = listing({ silhouette: null, measurements: { bust: 39, waist: null, hip: null, length: null } });
    // other: 36−1 … 36+2+2 = 35…40
    expect(measurementsFit(l, { bust: 36, waist: null, hip: null })).toBe(true);
  });
});

describe('matchesHardFilters', () => {
  it('budget window', () => {
    expect(matchesHardFilters(listing(), { priceMaxCents: 10000 })).toBe(false);
    expect(matchesHardFilters(listing(), { priceMinCents: 20000 })).toBe(false);
    expect(
      matchesHardFilters(listing(), { priceMinCents: 10000, priceMaxCents: 20000 }),
    ).toBe(true);
  });

  it('budget compares non-USD prices via the static FX USD equivalent (QA P1 #3)', () => {
    // £129.00 = 12900 pence → 12900 × 1.27 = 16383 USD cents
    const gbp = listing({ priceCents: 12900, currency: 'GBP' });
    expect(matchesHardFilters(gbp, { priceMaxCents: 16383 })).toBe(true);
    // raw-cents comparison would (wrongly) pass this — USD-equivalent must not
    expect(matchesHardFilters(gbp, { priceMaxCents: 15000 })).toBe(false);
    expect(matchesHardFilters(gbp, { priceMinCents: 16000 })).toBe(true);
    // unknown currency passes through 1:1 (permissive, never hides)
    const mystery = listing({ priceCents: 12900, currency: 'JPY' });
    expect(matchesHardFilters(mystery, { priceMaxCents: 15000 })).toBe(true);
  });

  it('condition / brand (case-insensitive) / color family', () => {
    expect(matchesHardFilters(listing(), { conditions: ['new', 'like_new'] })).toBe(true);
    expect(matchesHardFilters(listing(), { conditions: ['good'] })).toBe(false);
    expect(matchesHardFilters(listing(), { brands: ['reformation'] })).toBe(true);
    expect(matchesHardFilters(listing(), { brands: ['STAUD'] })).toBe(false);
    expect(matchesHardFilters(listing(), { colorFamilies: ['Blue'] })).toBe(true);
    expect(matchesHardFilters(listing(), { colorFamilies: ['red'] })).toBe(false);
  });

  it('free-text query over title + brand', () => {
    expect(matchesQuery(listing(), 'silk midi')).toBe(true);
    expect(matchesQuery(listing(), 'reformation silk')).toBe(true);
    expect(matchesQuery(listing(), 'velvet')).toBe(false);
    expect(matchesHardFilters(listing(), { query: 'midi reformation' })).toBe(true);
  });

  it('lengthOnBody uses the per-user hem (avoid-list semantics)', () => {
    const ctx = { heightInches: 64 };
    // 44″ on 5'4" → mid_calf
    expect(
      matchesHardFilters(listing(), { lengthOnBody: ['mid_calf', 'below_knee'] }, ctx),
    ).toBe(true);
    expect(matchesHardFilters(listing(), { lengthOnBody: ['knee'] }, ctx)).toBe(false);
  });

  it('unknown hem is excluded from lengthOnBody unless opted in', () => {
    const unknown = listing({ lengthInches: null, lengthClass: null });
    expect(
      matchesHardFilters(unknown, { lengthOnBody: ['knee'] }, { heightInches: 64 }),
    ).toBe(false);
    expect(
      matchesHardFilters(
        unknown,
        { lengthOnBody: ['knee'] },
        { heightInches: 64, includeUnknownLength: true },
      ),
    ).toBe(true);
  });

  it('lengthOnBody without a user height cannot classify → excluded', () => {
    expect(matchesHardFilters(listing(), { lengthOnBody: ['mid_calf'] })).toBe(false);
  });
});

describe('applyHardFilters — cap 500 newest-first', () => {
  it('sorts by lastSeenAt desc and caps', () => {
    const listings = Array.from({ length: 600 }, (_, i) =>
      listing({ id: `l${i}`, lastSeenAt: i }),
    );
    const result = applyHardFilters(listings, {});
    expect(result).toHaveLength(CANDIDATE_CAP);
    expect(result[0].lastSeenAt).toBe(599);
    expect(result[499].lastSeenAt).toBe(100);
  });
});

describe('stratifiedCap — source+brand stratification under the cap (2026-07-09)', () => {
  /** Sequential-crawl shape: brand A crawled LAST dominates the newest window. */
  function skewedPool(): Listing[] {
    const pool: Listing[] = [];
    for (let i = 0; i < 600; i++) {
      pool.push(
        listing({
          id: `a${i}`,
          brand: 'Brand A',
          sourceId: 'shopify:a.com',
          lastSeenAt: 2_000_000 + i, // crawled last — all newest
        }),
      );
    }
    for (const [b, base] of [
      ['Brand B', 1_000_000],
      ['Brand C', 900_000],
      ['Brand D', 800_000],
    ] as const) {
      for (let i = 0; i < 30; i++) {
        pool.push(
          listing({
            id: `${b[6].toLowerCase()}${i}`,
            brand: b,
            sourceId: `shopify:${b[6].toLowerCase()}.com`,
            lastSeenAt: base + i,
          }),
        );
      }
    }
    return pool;
  }

  it('every stratum is represented before any gets depth (dominant crawl no longer evicts)', () => {
    const result = stratifiedCap(skewedPool(), CANDIDATE_CAP);
    expect(result).toHaveLength(CANDIDATE_CAP);
    const byBrand = new Map<string, number>();
    for (const l of result) byBrand.set(l.brand!, (byBrand.get(l.brand!) ?? 0) + 1);
    // all 30 of each minority brand survive; the dominant brand fills the rest
    expect(byBrand.get('Brand B')).toBe(30);
    expect(byBrand.get('Brand C')).toBe(30);
    expect(byBrand.get('Brand D')).toBe(30);
    expect(byBrand.get('Brand A')).toBe(CANDIDATE_CAP - 90);
    expect(byBrand.size).toBe(4);
  });

  it('within a stratum the freshest listings survive', () => {
    const result = stratifiedCap(skewedPool(), CANDIDATE_CAP);
    const aTimes = result.filter((l) => l.brand === 'Brand A').map((l) => l.lastSeenAt);
    // A keeps its 410 newest (2_000_190 … 2_000_599)
    expect(Math.min(...aTimes)).toBe(2_000_000 + 600 - (CANDIDATE_CAP - 90));
    expect(Math.max(...aTimes)).toBe(2_000_599);
  });

  it('returns newest-first regardless of stratification', () => {
    const result = stratifiedCap(skewedPool(), CANDIDATE_CAP);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].lastSeenAt).toBeGreaterThanOrEqual(result[i].lastSeenAt);
    }
  });

  it('no-op (plain newest sort) when the pool fits under the cap', () => {
    const pool = skewedPool().slice(0, 100);
    const result = stratifiedCap(pool, CANDIDATE_CAP);
    expect(result).toHaveLength(100);
    expect(result.map((l) => l.id)).toEqual(
      [...pool].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((l) => l.id),
    );
  });

  it('applyHardFilters composes hard filters WITH stratification (budget still respected)', () => {
    const pool = skewedPool().map((l, i) =>
      // price every 3rd listing out of budget
      i % 3 === 0 ? { ...l, priceCents: 99_000 } : l,
    );
    const result = applyHardFilters(pool, { priceMaxCents: 20_000 }, undefined, 300);
    expect(result).toHaveLength(300);
    expect(result.every((l) => l.priceCents <= 20_000)).toBe(true);
    const brands = new Set(result.map((l) => l.brand));
    expect(brands.size).toBe(4);
  });
});
