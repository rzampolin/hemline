/**
 * Polite image fetcher tests — base64 image delivery (decisions #25):
 * media sniffing, oversized-image downscale rescue, hard-cap abort, retry
 * semantics, LRU + in-flight dedupe, and the identified SolineBot User-Agent.
 */
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  base64ImageBlock,
  createImageFetcher,
  DEFAULT_HARD_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  hemlineImageUserAgent,
  sniffImageMediaType,
  type ImageFetcher,
  type ImageFetcherOptions,
} from './fetcher';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);

function imageResponse(
  bytes: Uint8Array,
  init: { status?: number; contentType?: string | null } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'image/jpeg');
  return new Response(bytes.slice(), { status: init.status ?? 200, headers });
}

function fetcher(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<ImageFetcherOptions> = {},
): ImageFetcher {
  return createImageFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    minDelayMs: 0,
    sleep: async () => {},
    ...overrides,
  });
}

describe('sniffImageMediaType — magic bytes first, header second', () => {
  it('identifies the four supported formats from magic bytes', () => {
    expect(sniffImageMediaType(JPEG, null)).toBe('image/jpeg');
    expect(sniffImageMediaType(PNG, null)).toBe('image/png');
    expect(sniffImageMediaType(GIF, null)).toBe('image/gif');
    expect(sniffImageMediaType(WEBP, null)).toBe('image/webp');
  });

  it('magic bytes beat a lying Content-Type header (CDNs lie)', () => {
    expect(sniffImageMediaType(PNG, 'image/jpeg')).toBe('image/png');
    expect(sniffImageMediaType(JPEG, 'application/octet-stream')).toBe('image/jpeg');
  });

  it('falls back to a supported Content-Type when magic bytes are unknown', () => {
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImageMediaType(unknown, 'image/webp; charset=binary')).toBe('image/webp');
    expect(sniffImageMediaType(unknown, 'IMAGE/PNG')).toBe('image/png');
  });

  it('unknown bytes + unsupported/absent header → null', () => {
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImageMediaType(unknown, 'text/html')).toBeNull();
    expect(sniffImageMediaType(unknown, null)).toBeNull();
    expect(sniffImageMediaType(unknown, 'image/avif')).toBeNull(); // API doesn't take avif
  });
});

describe('createImageFetcher', () => {
  it('downloads, sniffs, and returns base64 + media type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(JPEG));
    const f = fetcher(fetchImpl);
    const result = await f.fetchImage('https://cdn.example.com/dress.jpg');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.image.mediaType).toBe('image/jpeg');
    expect(result.image.bytes).toBe(JPEG.byteLength);
    expect(Buffer.from(result.image.base64, 'base64')).toEqual(Buffer.from(JPEG));
    expect(f.stats).toMatchObject({ fetches: 1, cacheHits: 0, failures: 0 });
  });

  it('sends the identified SolineBot User-Agent (the whole point: we are a polite, NON-AI-labeled fetcher)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(JPEG));
    await fetcher(fetchImpl).fetchImage('https://cdn.example.com/a.jpg');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['user-agent']).toBe(hemlineImageUserAgent());
    expect(hemlineImageUserAgent()).toContain('SolineBot');
  });

  it('rejects images over the HARD cap with a clear too_large marker (declared Content-Length)', async () => {
    const headers = new Headers({
      'content-type': 'image/jpeg',
      'content-length': String(DEFAULT_HARD_MAX_IMAGE_BYTES + 1),
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JPEG.slice(), { status: 200, headers }));
    const result = await fetcher(fetchImpl).fetchImage('https://cdn.example.com/huge.jpg');
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('hard cap');
  });

  it('enforces the HARD cap mid-stream when no Content-Length is declared', async () => {
    const big = new Uint8Array(128);
    big.set(JPEG);
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(big));
    const f = fetcher(fetchImpl, { maxBytes: 32, hardMaxBytes: 64 });
    const result = await f.fetchImage('https://cdn.example.com/big.jpg');
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(f.stats.failures).toBe(1);
    expect(f.stats.downscales).toBe(0); // aborted before any rescue attempt
  });

  describe('oversized-image rescue (downscale instead of reject)', () => {
    /** A real PNG bigger than the tiny test cap, synthesized with sharp. */
    async function bigPng(width = 320, height = 400): Promise<Uint8Array> {
      // deterministic LCG noise defeats PNG compression → comfortably over a 4KB cap
      const raw = Buffer.alloc(width * height * 3);
      let state = 42;
      for (let i = 0; i < raw.length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        raw[i] = (state >>> 16) & 0xff;
      }
      const png = await sharp(raw, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer();
      expect(png.byteLength).toBeGreaterThan(4096);
      return new Uint8Array(png);
    }

    it('an image over the API cap (but under the hard cap) is downscaled to JPEG, not rejected', async () => {
      const png = await bigPng();
      const fetchImpl = vi.fn().mockResolvedValue(imageResponse(png, { contentType: 'image/png' }));
      const f = fetcher(fetchImpl, { maxBytes: 4096, downscaleEdgePx: 64 });
      const result = await f.fetchImage('https://cdn.example.com/oversized.png');

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.image.downscaled).toBe(true);
      expect(result.image.mediaType).toBe('image/jpeg');
      expect(result.image.bytes).toBeLessThanOrEqual(4096);
      // the payload really is a JPEG of the requested edge
      const meta = await sharp(Buffer.from(result.image.base64, 'base64')).metadata();
      expect(meta.format).toBe('jpeg');
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(64);
      expect(f.stats).toMatchObject({ fetches: 1, failures: 0, downscales: 1 });
    });

    it('a Content-Length over the API cap no longer short-circuits — the body is read and rescued', async () => {
      const png = await bigPng();
      const headers = new Headers({
        'content-type': 'image/png',
        'content-length': String(png.byteLength),
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(png.slice(), { status: 200, headers }));
      const f = fetcher(fetchImpl, { maxBytes: 4096, downscaleEdgePx: 64 });
      const result = await f.fetchImage('https://cdn.example.com/predicted-oversized.png');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.image.downscaled).toBe(true);
    });

    it('oversized bytes that only pretend to be an image → too_large with a downscale detail', async () => {
      const junk = new Uint8Array(8192);
      junk.set(JPEG); // JPEG magic, garbage body — sharp cannot decode it
      const fetchImpl = vi.fn().mockResolvedValue(imageResponse(junk));
      const f = fetcher(fetchImpl, { maxBytes: 4096 });
      const result = await f.fetchImage('https://cdn.example.com/corrupt-huge.jpg');
      expect(result).toMatchObject({ ok: false, reason: 'too_large' });
      if (result.ok) throw new Error('unreachable');
      expect(result.detail).toContain('could not be downscaled');
    });

    it('small images pass through untouched (no downscale, original bytes + media type)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(imageResponse(PNG, { contentType: 'image/png' }));
      const f = fetcher(fetchImpl);
      const result = await f.fetchImage('https://cdn.example.com/small.png');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.image.downscaled).toBeUndefined();
      expect(result.image.mediaType).toBe('image/png');
      expect(Buffer.from(result.image.base64, 'base64')).toEqual(Buffer.from(PNG));
      expect(f.stats.downscales).toBe(0);
    });

    it('the default caps: API limit 5MB < hard cap 20MB', () => {
      expect(DEFAULT_MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
      expect(DEFAULT_HARD_MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    });
  });

  it('non-image payloads → unsupported_media_type', async () => {
    const html = new TextEncoder().encode('<!doctype html><html>not found</html>');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(imageResponse(html, { contentType: 'text/html' }));
    const result = await fetcher(fetchImpl).fetchImage('https://cdn.example.com/soft-404');
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_media_type' });
  });

  it('non-retryable HTTP errors (403 robots-style blocks, 404) fail fast: ONE attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(JPEG, { status: 403 }));
    const result = await fetcher(fetchImpl, { attempts: 2 }).fetchImage(
      'https://cdn.example.com/blocked.jpg',
    );
    expect(result).toMatchObject({ ok: false, reason: 'http_error', detail: 'HTTP 403' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx within the attempt budget and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(imageResponse(JPEG, { status: 503 }))
      .mockResolvedValueOnce(imageResponse(JPEG));
    const result = await fetcher(fetchImpl, { attempts: 2 }).fetchImage(
      'https://cdn.example.com/flaky.jpg',
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('network errors exhaust the attempt budget → network_error with the last detail', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const f = fetcher(fetchImpl, { attempts: 2 });
    const result = await f.fetchImage('https://cdn.example.com/dead.jpg');
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('socket hang up');
    expect(result.detail).toContain('2 attempt(s)');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('LRU cache: the same URL is downloaded once per run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(PNG));
    const f = fetcher(fetchImpl);
    const a = await f.fetchImage('https://cdn.example.com/same.png');
    const b = await f.fetchImage('https://cdn.example.com/same.png');
    expect(a.ok && b.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.stats).toMatchObject({ fetches: 1, cacheHits: 1 });
  });

  it('LRU evicts by byte budget (oldest first)', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => imageResponse(JPEG)); // 12 bytes each
    const f = fetcher(fetchImpl, { maxCacheBytes: 25 }); // holds two 12-byte images
    await f.fetchImage('https://cdn.example.com/1.jpg');
    await f.fetchImage('https://cdn.example.com/2.jpg');
    await f.fetchImage('https://cdn.example.com/3.jpg'); // evicts 1.jpg
    await f.fetchImage('https://cdn.example.com/1.jpg'); // re-downloads
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await f.fetchImage('https://cdn.example.com/3.jpg'); // still cached
    expect(f.stats.cacheHits).toBe(1);
  });

  it('concurrent fetches of one URL share a single download (in-flight dedupe)', async () => {
    let release: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => (release = r));
    const fetchImpl = vi.fn().mockReturnValue(gate);
    const f = fetcher(fetchImpl);
    const [pa, pb] = [
      f.fetchImage('https://cdn.example.com/slow.jpg'),
      f.fetchImage('https://cdn.example.com/slow.jpg'),
    ];
    release(imageResponse(JPEG));
    const [a, b] = await Promise.all([pa, pb]);
    expect(a.ok && b.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('base64ImageBlock', () => {
  it('shapes a FetchedImage as an Anthropic base64 image block', () => {
    expect(
      base64ImageBlock({ base64: 'aW1n', mediaType: 'image/webp', bytes: 3 }),
    ).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'aW1n' },
    });
  });
});
