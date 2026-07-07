import { describe, expect, it } from 'vitest';
import type { Listing } from '@hemline/contracts';
import {
  applyHardFilters,
  CANDIDATE_CAP,
  matchesHardFilters,
  matchesQuery,
  measurementsFit,
  sizeCompatible,
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
