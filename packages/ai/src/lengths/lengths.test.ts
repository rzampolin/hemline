/**
 * Vision length-estimation tests: clamping, prompt/schema shape, and the
 * estimator's outcome mapping (Task 2, 2026-07-07).
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createCostMeter, type AiClient } from '../client';
import type { ImageFetcher } from '../images/fetcher';
import {
  buildLengthEstimationUserText,
  clampLengthEstimate,
  createLengthEstimator,
  DEFAULT_LANDMARKS_IN,
  DEFAULT_MODEL_HEIGHT_IN,
  formatFeetInches,
  LENGTH_CLASS_BANDS_IN,
  LENGTH_ESTIMATION_SYSTEM_PROMPT,
  LengthEstimateOutputSchema,
  scaleLandmarks,
  type LengthEstimateInput,
} from './index';

describe('clampLengthEstimate — §5 prior-band sanity clamp', () => {
  it('keeps an in-band estimate', () => {
    expect(clampLengthEstimate(44, 'midi')).toEqual({ lengthInches: 44, clamped: false });
    expect(clampLengthEstimate(33.24, 'mini')).toEqual({ lengthInches: 33.2, clamped: false });
  });

  it('tolerates small disagreement with the marketing class (±2")', () => {
    // mini band tops out at 34.5; 36" is within tolerance
    expect(clampLengthEstimate(36, 'mini').clamped).toBe(false);
    expect(clampLengthEstimate(30, 'mini').clamped).toBe(false);
  });

  it("distrusts a wild estimate: 'mini' at 55\" → keep class prior, clamped", () => {
    expect(clampLengthEstimate(55, 'mini')).toEqual({ lengthInches: null, clamped: true });
  });

  it('clamps implausible lengths regardless of class', () => {
    expect(clampLengthEstimate(8, null)).toEqual({ lengthInches: null, clamped: true });
    expect(clampLengthEstimate(90, null)).toEqual({ lengthInches: null, clamped: true });
  });

  it('no class → any plausible dress length passes', () => {
    expect(clampLengthEstimate(52, null)).toEqual({ lengthInches: 52, clamped: false });
  });

  it('null estimate passes through un-clamped', () => {
    expect(clampLengthEstimate(null, 'midi')).toEqual({ lengthInches: null, clamped: false });
  });

  it('bands are contiguous and cover every class', () => {
    const classes = Object.keys(LENGTH_CLASS_BANDS_IN);
    expect(classes).toHaveLength(8);
    for (const band of Object.values(LENGTH_CLASS_BANDS_IN)) {
      expect(band.min).toBeLessThan(band.max);
    }
    // §5 canonical priors sit inside their own bands
    expect(clampLengthEstimate(44, 'midi').clamped).toBe(false); // midi prior 44
    expect(clampLengthEstimate(55, 'maxi').clamped).toBe(false); // maxi prior 55
  });
});

describe('prompt & schema shape', () => {
  it('schema accepts the constrained output and rejects drift', () => {
    expect(
      LengthEstimateOutputSchema.parse({ lengthInches: 38, confidence: 0.8, reasoning: 'knee hem' }),
    ).toEqual({ lengthInches: 38, confidence: 0.8, reasoning: 'knee hem' });
    expect(
      LengthEstimateOutputSchema.parse({ lengthInches: null, confidence: 0, reasoning: null })
        .lengthInches,
    ).toBeNull();
    expect(
      LengthEstimateOutputSchema.safeParse({ lengthInches: 'about 38', confidence: 0.8, reasoning: null })
        .success,
    ).toBe(false);
  });

  it("prompt states the ~5'9\" model anchor, HPS basis, and self-assessed confidence", () => {
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toContain("5'9");
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toContain('175 cm');
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toMatch(/high point of the shoulder|HPS/);
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toContain('self-assessment');
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toContain('ESTIMATE');
  });

  it('user text carries title + length class', () => {
    const text = buildLengthEstimationUserText({
      contentHash: 'h',
      primaryImageUrl: 'https://cdn/x.jpg',
      title: 'Silk Midi Dress',
      lengthClass: 'midi',
      silhouette: 'slip',
    });
    expect(text).toContain('Silk Midi Dress');
    expect(text).toContain('midi');
    expect(text).toContain('slip');
    expect(text).not.toContain('MODEL HEIGHT'); // no stated height → default anchor only
  });

  it('prompt teaches the stated-height override (v2 anchoring)', () => {
    expect(LENGTH_ESTIMATION_SYSTEM_PROMPT).toContain('MODEL HEIGHT (stated on the listing)');
  });
});

describe('v2 anchoring — scaled landmarks & anchored user text', () => {
  it('scales the 69" landmarks linearly to the stated height', () => {
    // 5'10" model: everything × 70/69
    expect(scaleLandmarks(70)).toEqual({ shoulder: 57.3, knee: 19.8, midCalf: 11.2, ankle: 3 });
    // identity at the default anchor
    expect(scaleLandmarks(DEFAULT_MODEL_HEIGHT_IN)).toEqual({ ...DEFAULT_LANDMARKS_IN });
    // petite-end sanity: 5'2" scales down
    expect(scaleLandmarks(62).shoulder).toBeCloseTo(50.8, 1);
  });

  it('formats heights for the prompt', () => {
    expect(formatFeetInches(70)).toBe(`5'10"`);
    expect(formatFeetInches(69)).toBe(`5'9"`);
    expect(formatFeetInches(68.9)).toBe(`5'8.9"`);
  });

  it('stated height → user text anchors on it with scaled landmarks + size worn', () => {
    const text = buildLengthEstimationUserText({
      contentHash: 'h',
      primaryImageUrl: 'https://cdn/x.jpg',
      title: 'Sylvie Midi Dress',
      lengthClass: 'midi',
      statedModelHeightInches: 70,
      modelSizeWorn: 'S',
    });
    expect(text).toContain('MODEL HEIGHT (stated on the listing): 70"');
    expect(text).toContain(`5'10"`);
    expect(text).toContain('57.3'); // scaled shoulder
    expect(text).toContain('19.8'); // scaled knee
    expect(text).toContain('MODEL WEARS SIZE: S');
  });
});

// ── estimator (stubbed Anthropic client) ──────────────────────────────────

function fakeResponse(payload: unknown): unknown {
  return {
    usage: { input_tokens: 1750, output_tokens: 100 },
    content: [{ type: 'text', text: JSON.stringify(payload) }],
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

const anInput: LengthEstimateInput = {
  contentHash: 'hash1',
  primaryImageUrl: 'https://cdn/dress.jpg',
  title: 'Sage Knee-Length Dress',
  lengthClass: 'knee',
};

/** Stubbed polite fetcher — the default base64 delivery downloads via this. */
function okImageFetcher(): ImageFetcher {
  return {
    fetchImage: vi
      .fn()
      .mockResolvedValue({ ok: true, image: { base64: 'aW1n', mediaType: 'image/jpeg', bytes: 3 } }),
    stats: { fetches: 0, cacheHits: 0, failures: 0 },
  };
}

function failingImageFetcher(reason = 'http_error', detail = 'HTTP 403'): ImageFetcher {
  return {
    fetchImage: vi.fn().mockResolvedValue({ ok: false, reason, detail }),
    stats: { fetches: 0, cacheHits: 0, failures: 1 },
  };
}

describe('createLengthEstimator', () => {
  it('sends ONE vision call: OUR downloaded image inlined as base64 + grounded text, schema-constrained', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: 39, confidence: 0.8, reasoning: 'knee' }));
    const imageFetcher = okImageFetcher();
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageFetcher,
      logger: () => {},
    });
    const result = await estimator.estimateOne(anInput);

    expect(result.status).toBe('estimated');
    expect(result.lengthInches).toBe(39);
    expect(create).toHaveBeenCalledTimes(1);
    expect(imageFetcher.fetchImage).toHaveBeenCalledWith('https://cdn/dress.jpg');
    const req = create.mock.calls[0][0];
    // base64 source — the API is never asked to fetch a URL (decisions #25)
    expect(req.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1n' },
    });
    expect(req.output_config?.format).toBeDefined();
    expect(req.system[0].text).toBe(LENGTH_ESTIMATION_SYSTEM_PROMPT);
    expect(estimator.stats).toMatchObject({ calls: 1, estimated: 1 });
    expect(estimator.costUsd()).toBeGreaterThan(0);
  });

  it('our download fails → image_unavailable (terminal) with ZERO API calls', async () => {
    const logs: string[] = [];
    const create = vi.fn();
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageFetcher: failingImageFetcher('http_error', 'HTTP 403'),
      logger: (m) => logs.push(m),
    });
    const result = await estimator.estimateOne(anInput);

    expect(result.status).toBe('image_unavailable'); // NOT 'failed' — queue must drain
    expect(result.lengthInches).toBeNull();
    expect(result.error).toContain('http_error');
    expect(result.error).toContain('HTTP 403');
    expect(create).not.toHaveBeenCalled(); // no API spend on an undeliverable image
    expect(estimator.stats).toMatchObject({ imageUnavailable: 1, failed: 0, calls: 0 });
    expect(logs.some((l) => l.includes('[IMAGE-DOWNLOAD]') && l.includes('not_estimable'))).toBe(
      true,
    );
  });

  it('oversized image → image_unavailable with the clear too_large marker', async () => {
    const create = vi.fn();
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageFetcher: failingImageFetcher('too_large', 'image exceeds the 5MB cap'),
      logger: () => {},
    });
    const result = await estimator.estimateOne(anInput);
    expect(result.status).toBe('image_unavailable');
    expect(result.error).toContain('too_large');
    expect(create).not.toHaveBeenCalled();
  });

  it('out-of-band estimate → clamped: keep class prior, low confidence, no inches', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: 58, confidence: 0.9, reasoning: 'floor?' }));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    const result = await estimator.estimateOne(anInput); // class: knee

    expect(result.status).toBe('clamped');
    expect(result.lengthInches).toBeNull();
    expect(result.rawLengthInches).toBe(58);
    expect(result.modelConfidence).toBeLessThanOrEqual(0.2);
  });

  it('model returns null → no_estimate (marked attempted by the runner)', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: null, confidence: 0, reasoning: 'flat lay' }));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    expect((await estimator.estimateOne(anInput)).status).toBe('no_estimate');
  });

  it('records the default anchor when no stated height exists', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: 39, confidence: 0.8, reasoning: null }));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    const result = await estimator.estimateOne(anInput);
    expect(result.anchor).toBe('assumed_default');
    expect(result.anchorHeightInches).toBe(69);
  });

  it('stated model height → anchored prompt and anchor recorded on the result', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: 40, confidence: 0.8, reasoning: 'knee' }));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    const result = await estimator.estimateOne({
      ...anInput,
      statedModelHeightInches: 70.5,
      modelSizeWorn: 'S',
    });

    expect(result.status).toBe('estimated');
    expect(result.anchor).toBe('stated_model_height');
    expect(result.anchorHeightInches).toBe(70.5);
    const sentText = create.mock.calls[0][0].messages[0].content[1].text as string;
    expect(sentText).toContain('MODEL HEIGHT (stated on the listing): 70.5"');
    expect(sentText).toContain('MODEL WEARS SIZE: S');
  });

  it('anchor rides along on clamped/no-estimate/failed outcomes too', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeResponse({ lengthInches: null, confidence: 0, reasoning: 'flat lay' }));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    const result = await estimator.estimateOne({ ...anInput, statedModelHeightInches: 72 });
    expect(result.status).toBe('no_estimate');
    expect(result.anchor).toBe('stated_model_height');
    expect(result.anchorHeightInches).toBe(72);
  });

  it('API error → failed (left queued for resume)', async () => {
    const create = vi.fn().mockRejectedValue(new Error('529 overloaded'));
    const estimator = createLengthEstimator({ client: liveClientWith(create), imageFetcher: okImageFetcher(), logger: () => {} });
    const result = await estimator.estimateOne(anInput);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('529');
  });

  it('legacy url mode: API image-download 400 → image_unavailable after the retry budget (terminal, distinct log)', async () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
        '"Unable to download the file. Please verify the URL and try again."}}',
    );
    (err as Error & { status: number }).status = 400;
    const logs: string[] = [];
    const create = vi.fn().mockRejectedValue(err);
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageDelivery: 'url',
      imageDownloadAttempts: 2,
      logger: (m) => logs.push(m),
    });
    const result = await estimator.estimateOne(anInput);

    expect(result.status).toBe('image_unavailable'); // NOT 'failed' — queue must drain
    expect(result.lengthInches).toBeNull();
    expect(result.error).toContain('Unable to download');
    expect(create).toHaveBeenCalledTimes(2); // exactly the retry budget
    expect(estimator.stats).toMatchObject({ imageUnavailable: 1, failed: 0, calls: 0 });
    expect(logs.some((l) => l.includes('[IMAGE-URL]') && l.includes('not_estimable'))).toBe(true);
  });

  it('legacy url mode: transient download blip fails once, succeeds on retry → estimated', async () => {
    const err = new Error('400 invalid_request_error: Unable to download the file.');
    (err as Error & { status: number }).status = 400;
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(fakeResponse({ lengthInches: 39, confidence: 0.8, reasoning: 'knee' }));
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageDelivery: 'url',
      logger: () => {},
    });
    const result = await estimator.estimateOne(anInput);
    expect(result.status).toBe('estimated');
    expect(result.lengthInches).toBe(39);
    expect(estimator.stats).toMatchObject({ imageUnavailable: 0, estimated: 1 });
  });

  it('base64 mode never maps API download-phrased errors to image_unavailable (nothing left for the API to download)', async () => {
    const err = new Error('400 invalid_request_error: Unable to download the file.');
    (err as Error & { status: number }).status = 400;
    const create = vi.fn().mockRejectedValue(err);
    const estimator = createLengthEstimator({
      client: liveClientWith(create),
      imageFetcher: okImageFetcher(),
      logger: () => {},
    });
    const result = await estimator.estimateOne(anInput);
    expect(result.status).toBe('failed'); // generic API failure — retryable, not terminal
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keyless/budget-capped client → failed without calling the API', async () => {
    const create = vi.fn();
    const client = { ...liveClientWith(create), effectiveMode: () => 'mock' as const };
    const estimator = createLengthEstimator({ client, logger: () => {} });
    const result = await estimator.estimateOne(anInput);
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });
});
