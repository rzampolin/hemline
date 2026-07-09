import { describe, expect, it } from 'vitest';
import type { Listing, UserProfile } from '@hemline/contracts';
import { createMatchingService } from './matching-service';
import {
  attributeMatchScore,
  blendRelevance,
  blendSearchScore,
  countSoftSignals,
  lexicalMatchScore,
  normalizeSemanticScores,
  RELEVANCE_WEIGHTS,
  SEARCH_BLEND_WEIGHT,
  semanticTopK,
  type SoftQuerySignals,
} from './search-relevance';

const soft = (overrides: Partial<SoftQuerySignals> = {}): SoftQuerySignals => ({
  occasions: [],
  colorFamilies: [],
  fabrics: [],
  silhouettes: [],
  necklines: [],
  patterns: [],
  ...overrides,
});

describe('attributeMatchScore', () => {
  it('null when the query has no soft signals (skip, not zero)', () => {
    expect(attributeMatchScore(soft(), { 'color:pink': 0.8 })).toBeNull();
  });

  it('fraction of soft signals present in the sparse attribute vector', () => {
    const s = soft({ occasions: ['formal'], colorFamilies: ['pink'] });
    expect(attributeMatchScore(s, { 'occasion:formal': 0.4, 'color:pink': 0.8 })).toBe(1);
    expect(attributeMatchScore(s, { 'occasion:formal': 0.4 })).toBe(0.5);
    expect(attributeMatchScore(s, {})).toBe(0);
  });

  it('multi-word fabric values match their first-word tag', () => {
    const s = soft({ fabrics: ['silk charmeuse'] });
    expect(attributeMatchScore(s, { 'fabric:silk': 0.6 })).toBe(1);
  });

  it('countSoftSignals counts across every kind', () => {
    expect(countSoftSignals(soft({ occasions: ['formal'], necklines: ['square'] }))).toBe(2);
    expect(countSoftSignals(soft())).toBe(0);
  });
});

describe('lexicalMatchScore', () => {
  it('null when there are no residual tokens', () => {
    expect(lexicalMatchScore([], 'anything')).toBeNull();
  });

  it('fraction of tokens found, case-insensitive, over any haystack text', () => {
    expect(lexicalMatchScore(['summer', 'linen'], 'Breezy SUMMER dress')).toBe(0.5);
    expect(lexicalMatchScore(['summer'], 'wintery things')).toBe(0);
  });
});

describe('normalizeSemanticScores / semanticTopK', () => {
  it('min-max normalizes within the candidate set', () => {
    const raw = new Map([
      ['a', 0.52],
      ['b', 0.6],
      ['c', 0.56],
    ]);
    const n = normalizeSemanticScores(raw);
    expect(n.get('b')).toBe(1);
    expect(n.get('a')).toBe(0);
    expect(n.get('c')).toBeCloseTo(0.5);
  });

  it('constant scores map to neutral 0.5; empty input stays empty', () => {
    const n = normalizeSemanticScores(new Map([['a', 0.5], ['b', 0.5]]));
    expect(n.get('a')).toBe(0.5);
    expect(normalizeSemanticScores(new Map()).size).toBe(0);
  });

  it('topK returns the K best raw ids (the semantic evidence set)', () => {
    const raw = new Map([['a', 0.9], ['b', 0.1], ['c', 0.5]]);
    expect(semanticTopK(raw, 2)).toEqual(new Set(['a', 'c']));
  });
});

describe('blendRelevance (renormalizing .5/.3/.2 weights)', () => {
  it('all three components → straight weighted sum', () => {
    const r = blendRelevance({ attribute: 1, semantic: 0.5, lexical: 0 });
    expect(r).toBeCloseTo(
      RELEVANCE_WEIGHTS.attribute * 1 + RELEVANCE_WEIGHTS.semantic * 0.5,
    );
  });

  it('missing components redistribute weight (semantic never a gate)', () => {
    // no vectors: attribute + lexical renormalize to .5/.2 over .7
    expect(blendRelevance({ attribute: 1, semantic: null, lexical: 1 })).toBe(1);
    expect(blendRelevance({ attribute: 1, semantic: null, lexical: 0 })).toBeCloseTo(0.5 / 0.7);
    // semantic-only query ("cottagecore" with vectors)
    expect(blendRelevance({ attribute: null, semantic: 0.8, lexical: null })).toBeCloseTo(0.8);
  });

  it('null when no component is available', () => {
    expect(blendRelevance({ attribute: null, semantic: null, lexical: null })).toBeNull();
  });
});

describe('blendSearchScore', () => {
  it('0.7·relevance + 0.3·score₀', () => {
    expect(blendSearchScore(1, 0)).toBeCloseTo(SEARCH_BLEND_WEIGHT);
    expect(blendSearchScore(0.5, 0.5)).toBeCloseTo(0.5);
  });
});

/* ── service integration: the searchRelevance port ───────────────────────── */

function listing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    sourceId: 'fixture:shopify',
    sourceUrl: `https://example.com/${id}`,
    affiliateUrl: null,
    title: `Dress ${id}`,
    brand: 'Reformation',
    priceCents: 15000,
    currency: 'USD',
    images: [],
    sizeLabels: [],
    sizeNormalized: [],
    availability: {},
    condition: 'new',
    isVintage: false,
    era: null,
    colors: [],
    lengthClass: 'midi',
    lengthInches: null,
    measurements: { bust: null, waist: null, hip: null, length: null },
    fabric: null,
    neckline: null,
    silhouette: null,
    extractionConfidence: 0.5,
    lastSeenAt: 0,
    firstSeenAt: 0,
    ...overrides,
  };
}

const guest: UserProfile = {
  id: 'guest',
  heightInches: null,
  heelPrefInches: 0,
  sizesNormalized: [],
  bodyMeasurements: { bust: null, waist: null, hip: null },
  brandSizes: [],
  lengthPrefs: [],
  coveragePrefs: {},
  budget: { minCents: null, maxCents: null },
  colorSeason: null,
  palette: [],
  styleTags: {},
  onboarded: false,
};

describe('matching service: searchRelevance port (additive)', () => {
  const candidates = [listing('low'), listing('high')];

  it('reorders by blended search score when the port is present', async () => {
    const service = createMatchingService({
      loadProfile: async () => guest,
      loadCandidates: async () => candidates,
      searchRelevance: (l) => (l.id === 'high' ? 1 : 0),
      now: () => 0,
    });
    const res = await service.rank({
      userId: 'guest',
      filters: {},
      limit: 10,
      personalize: false,
    });
    expect(res.items.map((i) => i.listing.id)).toEqual(['high', 'low']);
    // identical base scores → the gap is exactly the 0.7-weighted relevance
    expect(res.items[0].score - res.items[1].score).toBeCloseTo(SEARCH_BLEND_WEIGHT);
  });

  it('port returning null (or absent) leaves score₀ untouched', async () => {
    const withNullPort = createMatchingService({
      loadProfile: async () => guest,
      loadCandidates: async () => candidates,
      searchRelevance: () => null,
      now: () => 0,
    });
    const without = createMatchingService({
      loadProfile: async () => guest,
      loadCandidates: async () => candidates,
      now: () => 0,
    });
    const a = await withNullPort.rank({ userId: 'g', filters: {}, limit: 10, personalize: false });
    const b = await without.rank({ userId: 'g', filters: {}, limit: 10, personalize: false });
    expect(a.items.map((i) => [i.listing.id, i.score])).toEqual(
      b.items.map((i) => [i.listing.id, i.score]),
    );
  });
});
