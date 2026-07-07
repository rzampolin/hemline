import { describe, expect, it } from 'vitest';
import type { Listing, RankedListing, UserProfile } from '@hemline/contracts';
import { createAiClient } from '../client';
import {
  createReranker,
  deterministicRerank,
  InMemoryRerankCache,
  rerankCacheKey,
  templatedWhy,
} from './index';

const MOCK_ENV = {} as NodeJS.ProcessEnv;

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'u1',
    heightInches: 64,
    heelPrefInches: 0,
    sizesNormalized: [8],
    bodyMeasurements: { bust: null, waist: null, hip: null },
    brandSizes: [],
    lengthPrefs: ['mid_calf'],
    coveragePrefs: {},
    budget: { minCents: null, maxCents: 20000 },
    colorSeason: 'soft_autumn',
    palette: [{ hex: '#9CAF88', name: 'sage' }],
    styleTags: { 'silhouette:slip': 1 },
    onboarded: true,
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<Listing> = {}): RankedListing {
  return {
    listing: {
      id,
      sourceId: 'fixture:shopify',
      sourceUrl: `https://example.com/${id}`,
      affiliateUrl: null,
      title: `Dress ${id}`,
      brand: 'Reformation',
      priceCents: 15000,
      currency: 'USD',
      images: [],
      sizeLabels: ['8'],
      sizeNormalized: [8],
      availability: {},
      condition: 'new',
      isVintage: false,
      era: null,
      colors: [{ name: 'sage', family: 'green', hex: '#9CAF88' }],
      lengthClass: 'midi',
      lengthInches: 44,
      measurements: { bust: null, waist: null, hip: null, length: 44 },
      fabric: 'silk',
      neckline: 'v_neck',
      silhouette: 'slip',
      extractionConfidence: 0.9,
      lastSeenAt: 0,
      firstSeenAt: 0,
      ...overrides,
    },
    hem: {
      position: 'mid_calf',
      hemAboveFloorInches: 8.48,
      basis: 'measured_length',
      confidence: 'high',
    },
    score: 0.5,
    whyItWorks: null,
    freshnessDecay: 1,
  };
}

describe('deterministic re-rank fallback (keyless)', () => {
  it('keeps incoming order and templates one-line reasons from real attributes', () => {
    const result = deterministicRerank(profile(), [candidate('a'), candidate('b')]);
    expect(result.mode).toBe('deterministic');
    expect(result.ranking).toEqual(['a', 'b']);
    expect(result.costUsd).toBeNull();
    expect(result.reasons.a).toMatch(/mid calf on you/i);
    expect(result.reasons.a).toMatch(/palette/i);
    expect(result.reasons.a.length).toBeLessThan(120);
  });

  it('templatedWhy degrades gracefully without hem/palette', () => {
    const bare = candidate('x', { colors: [], silhouette: null, brand: null });
    bare.hem = { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
    const why = templatedWhy(profile({ colorSeason: null, palette: [] }), bare);
    expect(why.length).toBeGreaterThan(10);
    expect(why.endsWith('.')).toBe(true);
  });

  it('reranker in mock mode logs the fallback and returns deterministic order', async () => {
    const logs: string[] = [];
    const rerank = createReranker({
      client: createAiClient(MOCK_ENV),
      logger: (m) => logs.push(m),
    });
    const result = await rerank(profile(), [candidate('a'), candidate('b')]);
    expect(result.mode).toBe('deterministic');
    expect(logs.some((l) => l.includes('[MOCK]'))).toBe(true);
  });

  it('empty candidate list short-circuits', async () => {
    const rerank = createReranker({ client: createAiClient(MOCK_ENV), logger: () => {} });
    const result = await rerank(profile(), []);
    expect(result.ranking).toEqual([]);
  });
});

describe('rerank cache key (doc §3 rerank_cache semantics)', () => {
  it('stable for identical inputs', () => {
    expect(rerankCacheKey(profile(), ['a', 'b'], 'silk')).toBe(
      rerankCacheKey(profile(), ['a', 'b'], 'silk'),
    );
  });

  it('changes when profile, candidates, or query change', () => {
    const base = rerankCacheKey(profile(), ['a', 'b'], 'silk');
    expect(rerankCacheKey(profile({ heightInches: 70 }), ['a', 'b'], 'silk')).not.toBe(base);
    expect(rerankCacheKey(profile(), ['a', 'c'], 'silk')).not.toBe(base);
    expect(rerankCacheKey(profile(), ['a', 'b'], 'velvet')).not.toBe(base);
    expect(rerankCacheKey(profile(), ['a', 'b'])).not.toBe(base);
  });

  it('insensitive to styleTags key order', () => {
    const a = profile({ styleTags: { x: 1, y: 0.5 } });
    const b = profile({ styleTags: { y: 0.5, x: 1 } });
    expect(rerankCacheKey(a, ['a'], undefined)).toBe(rerankCacheKey(b, ['a'], undefined));
  });
});

describe('InMemoryRerankCache TTL', () => {
  it('expires entries after their TTL', async () => {
    let nowMs = 1_000;
    const cache = new InMemoryRerankCache(() => nowMs);
    await cache.set('k', { ranking: ['a'], reasons: {}, costUsd: 0.001, mode: 'llm' }, 2_000);
    expect(await cache.get('k')).not.toBeNull();
    nowMs = 2_001;
    expect(await cache.get('k')).toBeNull();
  });
});
