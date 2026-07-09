import { describe, expect, it, vi } from 'vitest';
import type { Listing, RankedListing, UserProfile } from '@hemline/contracts';
import { createAiClient, createCostMeter, type AiClient } from '../client';
import {
  createReranker,
  deterministicRerank,
  estimateRerankOutputTokens,
  InMemoryRerankCache,
  rerankCacheKey,
  rerankMaxOutputTokens,
  RERANK_FAILURE_TTL_MS,
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

/* ── live-call sizing + failure hardening (2026-07-09 prod incident) ─────── */

type CreateFn = (req: unknown, opts?: unknown) => Promise<unknown>;

function liveClient(create: CreateFn): AiClient {
  return {
    mode: 'live',
    anthropic: { messages: { create } } as unknown as NonNullable<AiClient['anthropic']>,
    meter: createCostMeter({} as NodeJS.ProcessEnv),
    models: {
      extraction: 'claude-haiku-4-5-20251001',
      rerank: 'claude-haiku-4-5-20251001',
      color: 'claude-sonnet-4-6',
    },
    effectiveMode: () => 'live',
  };
}

function llmMessage(output: unknown, stopReason = 'end_turn') {
  return {
    stop_reason: stopReason,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 900, output_tokens: 350 },
  };
}

describe('output-size math (max_tokens right-sizing)', () => {
  it('worst case grows with candidate count and id length', () => {
    const short = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const many = Array.from({ length: 24 }, (_, i) => `id${i}`);
    const long = Array.from({ length: 24 }, (_, i) => `listing_${String(i).padStart(24, '0')}`);
    expect(estimateRerankOutputTokens(many)).toBeGreaterThan(estimateRerankOutputTokens(short));
    expect(estimateRerankOutputTokens(long)).toBeGreaterThan(estimateRerankOutputTokens(many));
  });

  it('max_tokens is 2× the worst case with a 512 floor', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `listing_${String(i).padStart(24, '0')}`);
    expect(rerankMaxOutputTokens(ids)).toBe(2 * estimateRerankOutputTokens(ids));
    expect(rerankMaxOutputTokens(['a'])).toBe(512);
  });

  it('documents the incident: 50 candidates × 18-word reasons overflow the old 1200 budget', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `listing_${String(i).padStart(20, '0')}`);
    expect(estimateRerankOutputTokens(ids, 18)).toBeGreaterThan(1200);
  });

  it('passes the computed max_tokens to the API', async () => {
    const cands = [candidate('a'), candidate('b')];
    const ids = cands.map((c) => c.listing.id);
    const create = vi.fn(async (_req: unknown) =>
      llmMessage({ ranking: ids, reasons: ids.map((id) => ({ id, reason: 'ok' })) }),
    );
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      logger: () => {},
    });
    await rerank(profile(), cands);
    const req = create.mock.calls[0][0] as { max_tokens: number };
    expect(req.max_tokens).toBe(rerankMaxOutputTokens(ids));
  });
});

describe('live call: success, truncation, timeout, negative cache', () => {
  it('successful call returns llm mode, caches, and the next call is a cache hit', async () => {
    const cands = [candidate('a'), candidate('b')];
    const output = {
      ranking: ['b', 'a'],
      reasons: [
        { id: 'a', reason: 'Fresh find in your size.' },
        { id: 'b', reason: 'Hits mid-calf on you.' },
      ],
    };
    const create = vi.fn(async () => llmMessage(output));
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      logger: () => {},
    });
    const r1 = await rerank(profile(), cands);
    expect(r1.mode).toBe('llm');
    expect(r1.ranking).toEqual(['b', 'a']);
    expect(r1.reasons.b).toMatch(/mid-calf/);
    const r2 = await rerank(profile(), cands);
    expect(r2.mode).toBe('cache');
    expect(r2.ranking).toEqual(['b', 'a']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('truncated response (stop_reason max_tokens) → loud log, deterministic fallback, 5min negative cache', async () => {
    let nowMs = 0;
    const cands = [candidate('a'), candidate('b')];
    const create = vi.fn(async () => llmMessage({ ranking: [], reasons: [] }, 'max_tokens'));
    const logs: string[] = [];
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(() => nowMs),
      logger: (m) => logs.push(m),
      now: () => nowMs,
    });

    const r1 = await rerank(profile(), cands);
    expect(r1.mode).toBe('deterministic');
    expect(r1.ranking).toEqual(['a', 'b']); // incoming order preserved
    expect(logs.some((l) => l.includes('TRUNCATED'))).toBe(true);

    // Within the failure TTL: negative cache absorbs the load — no re-spend.
    const r2 = await rerank(profile(), cands);
    expect(r2.mode).toBe('deterministic');
    expect(r2.reasons.a).toBeTruthy(); // fresh templated reasons, not empty
    expect(create).toHaveBeenCalledTimes(1);

    // After the TTL the live path is retried.
    nowMs = RERANK_FAILURE_TTL_MS + 1;
    await rerank(profile(), cands);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('hung API call hits the hard client-side timeout and negative-caches', async () => {
    const cands = [candidate('a')];
    const create = vi.fn(() => new Promise<never>(() => {})); // never resolves
    const logs: string[] = [];
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      timeoutMs: 25,
      logger: (m) => logs.push(m),
    });
    const t0 = Date.now();
    const r1 = await rerank(profile(), cands);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r1.mode).toBe('deterministic');
    expect(logs.some((l) => l.includes('timed out after 25ms'))).toBe(true);

    const r2 = await rerank(profile(), cands); // negative cache, no second hang
    expect(r2.mode).toBe('deterministic');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('background (deterministic-first) mode', () => {
  it('returns pending immediately (no LLM wait), background fill writes the cache, second call applies it synchronously', async () => {
    const cands = [candidate('a'), candidate('b')];
    const output = {
      ranking: ['b', 'a'],
      reasons: [{ id: 'b', reason: 'In your palette.' }],
    };
    const create = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(llmMessage(output)), 300)),
    );
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      background: true,
      logger: () => {},
    });

    const t0 = Date.now();
    const r1 = await rerank(profile(), cands, 'bg-success');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(250); // did NOT wait for the 300ms LLM call
    expect(r1.mode).toBe('pending');
    expect(r1.ranking).toEqual(['a', 'b']); // deterministic order served as-is
    expect(r1.costUsd).toBeNull();

    await rerank.flush();
    const r2 = await rerank(profile(), cands, 'bg-success');
    expect(r2.mode).toBe('cache');
    expect(r2.ranking).toEqual(['b', 'a']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('concurrent misses for the same key dedupe to one live call', async () => {
    const cands = [candidate('a'), candidate('b')];
    const create = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(llmMessage({ ranking: ['a', 'b'], reasons: [] })),
            50,
          ),
        ),
    );
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      background: true,
      logger: () => {},
    });
    const [r1, r2] = await Promise.all([
      rerank(profile(), cands, 'bg-dedupe'),
      rerank(profile(), cands, 'bg-dedupe'),
    ]);
    expect(r1.mode).toBe('pending');
    expect(r2.mode).toBe('pending');
    await rerank.flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('background failure negative-caches: later calls are deterministic (not pending) with no re-spend', async () => {
    const cands = [candidate('a'), candidate('b')];
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    const logs: string[] = [];
    const rerank = createReranker({
      client: liveClient(create),
      cache: new InMemoryRerankCache(),
      background: true,
      logger: (m) => logs.push(m),
    });
    const r1 = await rerank(profile(), cands, 'bg-failure');
    expect(r1.mode).toBe('pending');
    await rerank.flush();
    expect(logs.some((l) => l.includes('[RERANK]') && l.includes('boom'))).toBe(true);

    const r2 = await rerank(profile(), cands, 'bg-failure');
    expect(r2.mode).toBe('deterministic');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('cache-key stability during crawls', () => {
  it('insensitive to candidate ORDER (same head set, jittered scores → same key)', () => {
    expect(rerankCacheKey(profile(), ['a', 'b', 'c'])).toBe(rerankCacheKey(profile(), ['c', 'a', 'b']));
  });

  it('still sensitive to the candidate SET (new listing entering the head misses)', () => {
    expect(rerankCacheKey(profile(), ['a', 'b', 'c'])).not.toBe(rerankCacheKey(profile(), ['a', 'b', 'd']));
  });
});
