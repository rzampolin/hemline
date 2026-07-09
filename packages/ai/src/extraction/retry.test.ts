/**
 * Validation recovery ladder tests: retry-with-feedback → deterministic
 * coercion → mock fallback, with per-run stats (Task 1, 2026-07-07).
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ExtractionInput } from '@hemline/contracts';
import { createCostMeter, isImageUrlDownloadError, type AiClient } from '../client';
import { createExtractionService, InMemoryExtractionCache } from './index';

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

// ── image-URL download failures (production 2026-07: Reformation Cloudinary) ──

/** Weak text (no length/silhouette signal) + an image URL → image attached. */
function imageInput(hash: string): ExtractionInput {
  return {
    contentHash: hash,
    title: 'Emerald Dress',
    description: null,
    brand: null,
    primaryImageUrl: 'https://res.cloudinary.com/ref/image/upload/dress.jpg',
    attributeHints: null,
    sizeLabels: [],
  };
}

/** The exact production failure: 400 invalid_request_error on the image URL. */
function imageDownloadError(): Error {
  const err = new Error(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
      '"Unable to download the file. Please verify the URL and try again."}}',
  );
  (err as Error & { status: number }).status = 400;
  return err;
}

describe('isImageUrlDownloadError', () => {
  it('matches the production 400 shape (thrown SDK error)', () => {
    expect(isImageUrlDownloadError(imageDownloadError())).toBe(true);
  });

  it('matches Message Batches errored payloads', () => {
    expect(
      isImageUrlDownloadError({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Unable to download the file. Please verify the URL and try again.',
        },
      }),
    ).toBe(true);
  });

  it('matches the timed-out phrasing seen in prod (fell back to mock before the fix)', () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
        '"The request timed out while trying to download the file. Please try again later."}}',
    );
    (err as Error & { status: number }).status = 400;
    expect(isImageUrlDownloadError(err)).toBe(true);
    // and as a Message Batches errored payload
    expect(
      isImageUrlDownloadError({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'The request timed out while trying to download the file. Please try again later.',
        },
      }),
    ).toBe(true);
  });

  it('matches reworded download-failure semantics (verb/noun in either order)', () => {
    const reworded = new Error(
      '400 invalid_request_error: The image at the provided URL could not be fetched.',
    );
    (reworded as Error & { status: number }).status = 400;
    expect(isImageUrlDownloadError(reworded)).toBe(true);
  });

  it('does not match other 400s, overloads, or non-errors', () => {
    const other400 = new Error('400 invalid_request_error: max_tokens too large');
    (other400 as Error & { status: number }).status = 400;
    expect(isImageUrlDownloadError(other400)).toBe(false);
    expect(isImageUrlDownloadError(new Error('529 overloaded'))).toBe(false);
    expect(isImageUrlDownloadError('unable to download the file')).toBe(false);
    expect(isImageUrlDownloadError(null)).toBe(false);
  });
});

describe('extraction image-URL failure → TEXT-ONLY retry (never mock)', () => {
  it('retries the same listing without the image block; model recorded as live', async () => {
    const logs: string[] = [];
    const cache = new InMemoryExtractionCache();
    const create = vi
      .fn()
      .mockRejectedValueOnce(imageDownloadError())
      .mockResolvedValueOnce(fakeResponse(good));
    const service = createExtractionService({
      client: liveClientWith(create),
      cache,
      logger: (m) => logs.push(m),
    });
    const results = await service.extractBatch([imageInput('img1')]);

    // live extraction succeeded on the text-only retry
    expect(results.get('img1')!.silhouette).toBe('wrap');
    expect((await cache.get('img1'))!.model).toBe('claude-haiku-4-5-20251001'); // NOT 'mock'
    expect(create).toHaveBeenCalledTimes(2);
    // first attempt attached the image; the retry is text-only
    const firstContent = create.mock.calls[0][0].messages[0].content;
    const retryContent = create.mock.calls[1][0].messages[0].content;
    expect(firstContent.some((b: { type: string }) => b.type === 'image')).toBe(true);
    expect(retryContent.some((b: { type: string }) => b.type === 'image')).toBe(false);
    // tracked as an image failure, NOT a fallback
    expect(service.stats).toMatchObject({ imageUrlFailures: 1, fallbacks: 0, mockExtractions: 0 });
    expect(logs.some((l) => l.includes('[IMAGE-URL]') && l.includes('img1'))).toBe(true);
    expect(logs.some((l) => l.includes('[FALLBACK]'))).toBe(false);
  });

  it('text-only retry that fails for other reasons still ends at the mock fallback', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(imageDownloadError())
      .mockRejectedValue(new Error('529 overloaded'));
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    const results = await service.extractBatch([imageInput('img2')]);
    expect(results.get('img2')).toBeDefined(); // mock still answered
    expect(service.stats).toMatchObject({ imageUrlFailures: 1, fallbacks: 1, mockExtractions: 1 });
  });

  it('download error on a text-only request (no image sent) is NOT retried as image failure', async () => {
    const create = vi.fn().mockRejectedValue(imageDownloadError());
    const service = createExtractionService({ client: liveClientWith(create), logger: () => {} });
    await service.extractBatch([input('no-img')]); // input() has no primaryImageUrl
    expect(service.stats).toMatchObject({ imageUrlFailures: 0, fallbacks: 1 });
  });
});
