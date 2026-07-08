/**
 * Validation recovery ladder tests: retry-with-feedback → deterministic
 * coercion → mock fallback, with per-run stats (Task 1, 2026-07-07).
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ExtractionInput } from '@hemline/contracts';
import { createCostMeter, type AiClient } from '../client';
import { createExtractionService } from './index';

function fakeResponse(payload: unknown): unknown {
  return {
    usage: { input_tokens: 1000, output_tokens: 200 },
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  };
}

function liveClientWith(create: ReturnType<typeof vi.fn>): AiClient {
  return {
    mode: 'live',
    anthropic: { messages: { create } } as unknown as Anthropic,
    meter: createCostMeter({ AI_DAILY_BUDGET_USD: '100' } as unknown as NodeJS.ProcessEnv),
    models: { extraction: 'claude-haiku-4-5-20251001', rerank: 'x', color: 'x' },
    effectiveMode: () => 'live',
  };
}

function input(hash: string): ExtractionInput {
  return {
    contentHash: hash,
    title: 'Emerald Silk Wrap Midi Dress',
    description: 'v-neck, midi length',
    brand: null,
    primaryImageUrl: null,
    attributeHints: null,
    sizeLabels: [],
  };
}

const good = {
  lengthClass: 'midi',
  lengthInches: null,
  measurements: { bust: null, waist: null, hip: null, length: null },
  colors: [{ name: 'emerald', family: 'green', hex: '#50C878' }],
  fabric: 'silk',
  neckline: 'v_neck',
  silhouette: 'wrap',
  sleeve: null,
  pattern: 'solid',
  occasions: ['cocktail'],
  confidence: 0.9,
};

describe('extraction validation recovery ladder', () => {
  it('valid first response: no retry, no coercion', async () => {
    const create = vi.fn().mockResolvedValueOnce(fakeResponse(good));
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    const results = await service.extractBatch([input('h1')]);
    expect(results.get('h1')!.silhouette).toBe('wrap');
    expect(create).toHaveBeenCalledTimes(1);
    expect(service.stats).toMatchObject({ liveCalls: 1, retries: 0, coercions: 0, fallbacks: 0 });
  });

  it('invalid enum → ONE retry with validation feedback; corrected retry wins', async () => {
    const bad = { ...good, silhouette: 'flowy boho' };
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(bad))
      .mockResolvedValueOnce(fakeResponse(good));
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    const results = await service.extractBatch([input('h1')]);

    expect(results.get('h1')!.silhouette).toBe('wrap');
    expect(create).toHaveBeenCalledTimes(2);
    // the retry request feeds the errors back: user, assistant(bad), user(feedback)
    const retryMessages = create.mock.calls[1][0].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[1].role).toBe('assistant');
    expect(retryMessages[2].content).toContain('failed schema validation');
    expect(retryMessages[2].content).toContain('silhouette');
    expect(service.stats).toMatchObject({
      liveCalls: 2,
      retries: 1,
      retrySuccesses: 1,
      coercions: 0,
      fallbacks: 0,
    });
  });

  it('retry still invalid → deterministic coercion recovers the paid response', async () => {
    const bad = { ...good, silhouette: 'flowy boho', occasions: ['cocktail', 'gala night'] };
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(bad))
      .mockResolvedValueOnce(fakeResponse(bad)); // model repeats itself
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    const results = await service.extractBatch([input('h1')]);

    const attrs = results.get('h1')!;
    expect(attrs.silhouette).toBe('other'); // invalid enum → 'other'
    expect(attrs.occasions).toEqual(['cocktail']); // invalid array item dropped
    expect(attrs.fabric).toBe('silk'); // rest of the paid extraction preserved
    expect(create).toHaveBeenCalledTimes(2); // exactly ONE retry
    expect(service.stats).toMatchObject({ retries: 1, retrySuccesses: 0, coercions: 1, fallbacks: 0 });
  });

  it('unrecoverable output → mock fallback with a loud [FALLBACK] log incl. content hash', async () => {
    const logs: string[] = [];
    const create = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse('not json at all'))
      .mockResolvedValueOnce(fakeResponse('still not json'));
    const service = createExtractionService({
      client: liveClientWith(create),
      logger: (m) => logs.push(m),
    });
    const results = await service.extractBatch([input('deadbeefcafe')]);

    // mock rule engine still extracted from the text
    expect(results.get('deadbeefcafe')!.lengthClass).toBe('midi');
    expect(service.stats).toMatchObject({ retries: 1, coercions: 0, fallbacks: 1, mockExtractions: 1 });
    const fallbackLog = logs.find((l) => l.includes('[FALLBACK]'));
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog).toContain('deadbeefcafe'); // full content hash for triage
  });

  it('API error → mock fallback counted', async () => {
    const create = vi.fn().mockRejectedValue(new Error('529 overloaded'));
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    const results = await service.extractBatch([input('h1')]);
    expect(results.get('h1')).toBeDefined();
    expect(service.stats.fallbacks).toBe(1);
  });

  it('exposes accumulated costUsd for the run', async () => {
    const create = vi.fn().mockResolvedValue(fakeResponse(good));
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    await service.extractBatch([input('h1'), input('h2')]);
    // 2 calls × (1000 in × $1/MTok + 200 out × $5/MTok) = 2 × $0.002
    expect(service.costUsd()).toBeCloseTo(0.004, 6);
  });
});
