import { describe, expect, it } from 'vitest';
import type { Listing, UserProfile } from '@hemline/contracts';
import { createMatchingService, type RerankOutcome } from './matching-service';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

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
    lastSeenAt: NOW - DAY,
    firstSeenAt: NOW - 30 * DAY,
    ...overrides,
  };
}

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'user-1',
    heightInches: 64,
    heelPrefInches: 0,
    sizesNormalized: [8],
    bodyMeasurements: { bust: null, waist: null, hip: null },
    brandSizes: [],
    lengthPrefs: [],
    coveragePrefs: {},
    budget: { minCents: null, maxCents: null },
    colorSeason: null,
    palette: [],
    styleTags: {},
    onboarded: true,
    ...overrides,
  };
}

function makeService(listings: Listing[], opts: { rerank?: RerankOutcome; user?: UserProfile } = {}) {
  const calls: { rerankCandidates: string[][] } = { rerankCandidates: [] };
  const service = createMatchingService({
    loadProfile: async () => opts.user ?? profile(),
    loadCandidates: async () => listings,
    rerank: opts.rerank
      ? async (_p, candidates) => {
          calls.rerankCandidates.push(candidates.map((c) => c.listing.id));
          return opts.rerank!;
        }
      : undefined,
    now: () => NOW,
  });
  return { service, calls };
}

describe('createMatchingService.rank', () => {
  it('returns a well-formed RankResponse with per-user hems', async () => {
    const { service } = makeService([listing('a'), listing('b')]);
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.items).toHaveLength(2);
    expect(res.totalMatched).toBe(2);
    expect(res.nextCursor).toBeNull();
    expect(res.rerank).toEqual({ mode: 'deterministic', costUsd: null });
    // 44″ on 5'4" → mid_calf
    expect(res.items[0].hem.position).toBe('mid_calf');
    expect(res.items[0].whyItWorks).toBeNull();
    expect(res.items[0].freshnessDecay).toBeGreaterThan(0.9);
  });

  it('applies hard filters with the user context (budget example)', async () => {
    const cheap = listing('cheap', { priceCents: 5000 });
    const pricey = listing('pricey', { priceCents: 99000 });
    const { service } = makeService([cheap, pricey]);
    const res = await service.rank({
      userId: 'user-1',
      filters: { priceMaxCents: 10000 },
      limit: 24,
      personalize: false,
    });
    expect(res.items.map((i) => i.listing.id)).toEqual(['cheap']);
  });

  it('fresher listings outrank stale ones for a new user (neutral similarity)', async () => {
    const fresh = listing('fresh', { lastSeenAt: NOW - DAY });
    const stale = listing('stale', { lastSeenAt: NOW - 40 * DAY });
    const { service } = makeService([stale, fresh]);
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.items.map((i) => i.listing.id)).toEqual(['fresh', 'stale']);
    expect(res.items[1].freshnessDecay).toBeLessThan(res.items[0].freshnessDecay);
  });

  it('learned style tags reorder the feed deterministically', async () => {
    const slip = listing('slip', { silhouette: 'slip' });
    const shirt = listing('shirt', { silhouette: 'shirt' });
    const user = profile({ styleTags: { 'silhouette:shirt': 1.5 } });
    const { service } = makeService([slip, shirt], { user });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.items[0].listing.id).toBe('shirt');
  });

  it('personalize=true applies the re-ranker: order, why-lines, blended scores', async () => {
    const a = listing('a');
    const b = listing('b');
    const { service, calls } = makeService([a, b], {
      rerank: {
        ranking: ['b', 'a'],
        reasons: { b: 'Silk slip in your palette.', a: 'Fresh arrival in your size.' },
        costUsd: 0.004,
        mode: 'llm',
      },
    });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: true,
    });
    expect(calls.rerankCandidates[0]).toContain('a');
    expect(res.items.map((i) => i.listing.id)).toEqual(['b', 'a']);
    expect(res.items[0].whyItWorks).toBe('Silk slip in your palette.');
    expect(res.rerank).toEqual({ mode: 'llm', costUsd: 0.004 });
    // blended: position 0 → llm 1 → 0.6·1 + 0.4·score₀
    expect(res.items[0].score).toBeGreaterThan(0.6);
  });

  it('re-ranker failure falls back to deterministic order', async () => {
    const service = createMatchingService({
      loadProfile: async () => profile(),
      loadCandidates: async () => [listing('a')],
      rerank: async () => {
        throw new Error('LLM down');
      },
      now: () => NOW,
    });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: true,
    });
    expect(res.items).toHaveLength(1);
    expect(res.rerank.mode).toBe('deterministic');
  });

  it('ids the re-ranker drops keep deterministic order at the tail', async () => {
    const { service } = makeService([listing('a'), listing('b'), listing('c')], {
      rerank: { ranking: ['c'], reasons: {}, costUsd: 0.001, mode: 'llm' },
    });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: true,
    });
    expect(res.items[0].listing.id).toBe('c');
    expect(res.items.map((i) => i.listing.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('paginates with an opaque cursor', async () => {
    const listings = Array.from({ length: 5 }, (_, i) =>
      listing(`l${i}`, { lastSeenAt: NOW - i * DAY }),
    );
    const { service } = makeService(listings);
    const page1 = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 2,
      personalize: false,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 2,
      personalize: false,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(2);
    const ids1 = page1.items.map((i) => i.listing.id);
    const ids2 = page2.items.map((i) => i.listing.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    const page3 = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 2,
      personalize: false,
      cursor: page2.nextCursor!,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('user without height → hem basis none, listing still ranked', async () => {
    const { service } = makeService([listing('a')], {
      user: profile({ heightInches: null }),
    });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.items[0].hem).toEqual({
      position: null,
      hemAboveFloorInches: null,
      basis: 'none',
      confidence: 'low',
    });
  });

  it('exposes the contract hemForUser', async () => {
    const { service } = makeService([]);
    const hem = service.hemForUser({ lengthInches: 44, lengthClass: 'midi' }, 64, 0);
    expect(hem.position).toBe('mid_calf');
  });
});
