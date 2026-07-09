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

  it("re-ranker mode 'pending' serves the deterministic page untouched and reports pending", async () => {
    const fresh = listing('fresh', { lastSeenAt: NOW - DAY });
    const stale = listing('stale', { lastSeenAt: NOW - 40 * DAY });
    // Background reranker contract: identity ranking + empty reasons + 'pending'.
    const { service } = makeService([stale, fresh], {
      rerank: { ranking: ['fresh', 'stale'], reasons: {}, costUsd: null, mode: 'pending' },
    });
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: true,
    });
    expect(res.rerank).toEqual({ mode: 'pending', costUsd: null });

    // Identical order AND scores to the pure deterministic run — the identity
    // ranking must not be blended in as if it were an LLM opinion.
    const { service: baseline } = makeService([stale, fresh]);
    const base = await baseline.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.items.map((i) => i.listing.id)).toEqual(base.items.map((i) => i.listing.id));
    expect(res.items.map((i) => i.score)).toEqual(base.items.map((i) => i.score));
    expect(res.items.every((i) => i.whyItWorks === null)).toBe(true);
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

/* ── Brand-diversity guard (2026-07-09 monoculture fix) ──────────────────
 * One store's sequential crawl must not paint the whole page: with a pool of
 * 400 brand-A + 30 each B/C/D (A also freshest, i.e. highest-scored for a
 * neutral profile), the top-24 page still shows ≥4 brands, never 3-in-a-row. */
describe('brand-diversity guard in rank()', () => {
  function skewedListings(): Listing[] {
    const items: Listing[] = [];
    for (let i = 0; i < 400; i++) {
      items.push(
        listing(`a${i}`, {
          brand: 'Brand A',
          sourceId: 'shopify:a.com',
          lastSeenAt: NOW - i * 60_000, // crawled last — freshest block
        }),
      );
    }
    for (const [b, offsetDays] of [
      ['Brand B', 2],
      ['Brand C', 3],
      ['Brand D', 4],
    ] as const) {
      for (let i = 0; i < 30; i++) {
        items.push(
          listing(`${b.toLowerCase().replace(/\s/g, '')}${i}`, {
            brand: b,
            sourceId: `shopify:${b[6].toLowerCase()}.com`,
            lastSeenAt: NOW - offsetDays * DAY - i * 60_000,
          }),
        );
      }
    }
    return items;
  }

  it('top-24 page has ≥4 distinct brands and no 3-in-a-row', async () => {
    const { service } = makeService(skewedListings());
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    const brands = res.items.map((i) => i.listing.brand);
    expect(new Set(brands).size).toBeGreaterThanOrEqual(4);
    for (let i = 2; i < brands.length; i++) {
      expect(brands[i] === brands[i - 1] && brands[i] === brands[i - 2]).toBe(false);
    }
  });

  it('guard is a pure re-ordering: totalMatched and result set unchanged', async () => {
    const pool = skewedListings();
    const { service } = makeService(pool);
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 100,
      personalize: false,
    });
    expect(res.totalMatched).toBe(490); // full pool (under the cap) — nothing filtered out
    expect(new Set(res.items.map((i) => i.listing.id)).size).toBe(100);
  });

  it('stratified cap keeps minority brands in the pool despite a 400-item fresh crawl', async () => {
    // pool > cap: 600 A crushes the cap; B/C/D must all survive
    const items = skewedListings();
    for (let i = 400; i < 600; i++) {
      items.push(
        listing(`a${i}`, {
          brand: 'Brand A',
          sourceId: 'shopify:a.com',
          lastSeenAt: NOW - i * 60_000,
        }),
      );
    }
    const { service } = makeService(items);
    const res = await service.rank({
      userId: 'user-1',
      filters: {},
      limit: 24,
      personalize: false,
    });
    expect(res.totalMatched).toBe(500);
    expect(new Set(res.items.map((i) => i.listing.brand)).size).toBeGreaterThanOrEqual(4);
  });
});

/* ── D2 global palette-boost toggle (QA P1 #1, 2026-07-08) ────────────────
 * paletteBoostEnabled=false must neutralize the boost in the scoring
 * composition: same result SET (never hides — spec invariant), different
 * ORDER whenever palette matches exist to boost. */
describe('paletteBoostEnabled toggle', () => {
  const palette = [{ hex: '#9CAF88', name: 'sage' }];
  // Same freshness for both so only the palette boost can separate them.
  // 'plain' carries a small attribute-similarity edge (cos ≈ 0.2 → sim ≈ 0.6
  // vs the palette listing's neutral 0.5): smaller than the 1.25× boost
  // (0.5 × 1.25 = 0.625), so the winner flips with the toggle.
  const inPalette = Object.assign(
    listing('in-palette', { colors: [{ name: 'sage', family: 'green', hex: '#9CAF88' }] }),
    { attributeVector: { 'length:midi': 1 } },
  );
  const plain = Object.assign(
    listing('plain', { colors: [{ name: 'tangerine', family: 'orange', hex: '#F28500' }] }),
    { attributeVector: { 'length:midi': 1, 'silhouette:wrap': 0.2 } },
  );
  const styleTags = { 'silhouette:wrap': 1 };

  async function rankIds(paletteBoostEnabled: boolean | undefined) {
    const { service } = makeService([inPalette, plain], {
      user: profile({ palette, styleTags, paletteBoostEnabled }),
    });
    const res = await service.rank({ userId: 'user-1', filters: {}, limit: 24, personalize: false });
    return { ids: res.items.map((i) => i.listing.id), total: res.totalMatched, res };
  }

  it('boost on vs off: identical result SET, different order', async () => {
    const on = await rankIds(true);
    const off = await rankIds(false);
    expect([...on.ids].sort()).toEqual([...off.ids].sort()); // never hides
    expect(on.total).toBe(off.total);
    expect(on.ids).not.toEqual(off.ids); // boost re-orders
    expect(on.ids[0]).toBe('in-palette'); // 1.25× boost beats the small tag edge
    expect(off.ids[0]).toBe('plain'); // toggle off → tag similarity decides
  });

  it('undefined (legacy profiles) behaves as enabled', async () => {
    const legacy = await rankIds(undefined);
    const on = await rankIds(true);
    expect(legacy.ids).toEqual(on.ids);
  });

  it('toggle off with an empty palette is a no-op (order unchanged)', async () => {
    const { service } = makeService([inPalette, plain], {
      user: profile({ palette: [], styleTags, paletteBoostEnabled: false }),
    });
    const res = await service.rank({ userId: 'user-1', filters: {}, limit: 24, personalize: false });
    expect(res.items.map((i) => i.listing.id)).toEqual(['plain', 'in-palette']);
  });
});
