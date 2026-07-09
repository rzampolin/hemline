/**
 * Polite in-process image fetcher — base64 image delivery (decisions #25).
 *
 * WHY: Anthropic's URL fetcher respects robots.txt *for AI fetchers* and some
 * stores' image CDNs disallow those user agents (prod 2026-07: 400 "This URL
 * is disallowed by the website's robots.txt file" stopped the hem-lengths
 * vision pass at 5/10045). The same CDNs happily serve normal, identified
 * crawlers — our embed sidecar has downloaded thousands of these exact images
 * under HemlineBot with politeness. So we download the image ourselves and
 * send it to the API as base64; the API never fetches anything.
 *
 * Deliberately minimal and dependency-free (a subset of the connectors
 * politeness stack, re-implemented here so packages/ai does not grow an edge
 * onto packages/connectors and its drizzle dependency):
 *   - identified HemlineBot User-Agent (same contact as the crawlers)
 *   - per-attempt timeout, retry with backoff on network errors / 429 / 5xx
 *   - best-effort per-host min delay (no per-host serialization — the vision
 *     runners' concurrency is low and each request is followed by an API call,
 *     so a cheap delay is plenty polite)
 *   - hard size cap (default 5MB — the API's own per-image limit); enforced
 *     while streaming, so an oversized file is aborted, not fully downloaded
 *   - media type sniffed from magic bytes first, Content-Type header second
 *   - in-memory LRU (byte-capped) + in-flight dedupe keyed by URL, so the
 *     extraction and lengths passes never download the same image twice in a
 *     run
 */
import type Anthropic from '@anthropic-ai/sdk';

export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type ImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

/** The API rejects images over 5MB — reject before uploading, with a clear marker. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_IMAGE_FETCH_ATTEMPTS = 2;
export const DEFAULT_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;

export function hemlineImageUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  // Same identity string as packages/connectors politeness.ts — one bot name.
  return `HemlineBot/1.0 (+${env.CRAWLER_CONTACT ?? 'rzampolin15@gmail.com'})`;
}

export function defaultImageFetchDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.HEMLINE_IMAGE_FETCH_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 300;
}

export interface FetchedImage {
  base64: string;
  mediaType: ImageMediaType;
  bytes: number;
}

export type ImageFetchFailureReason =
  | 'http_error' // non-2xx after the retry budget
  | 'too_large' // over the size cap (clear marker per decisions #25)
  | 'unsupported_media_type' // neither magic bytes nor Content-Type identify a supported type
  | 'network_error'; // fetch threw / timed out after the retry budget

export type ImageFetchResult =
  | { ok: true; image: FetchedImage }
  | { ok: false; reason: ImageFetchFailureReason; detail: string };

export interface ImageFetcherStats {
  /** network downloads attempted (first attempts, not retries) */
  fetches: number;
  /** served from the LRU without touching the network */
  cacheHits: number;
  failures: number;
}

export interface ImageFetcher {
  fetchImage(url: string): Promise<ImageFetchResult>;
  readonly stats: ImageFetcherStats;
}

export interface ImageFetcherOptions {
  fetchImpl?: typeof fetch;
  /** hard size cap in bytes (default 5MB — the API's per-image limit) */
  maxBytes?: number;
  /** per-attempt timeout (default 20s) */
  timeoutMs?: number;
  /** total attempts on retryable failures (network / 429 / 5xx). Default 2. */
  attempts?: number;
  /** best-effort min delay between requests to the same host (default 300ms) */
  minDelayMs?: number;
  /** LRU byte budget for successful downloads (default 64MB) */
  maxCacheBytes?: number;
  userAgent?: string;
  /** injectable clock/sleep for tests */
  sleep?: (ms: number) => Promise<void>;
}

/** Magic-bytes first (CDNs lie in Content-Type), header second. */
export function sniffImageMediaType(
  bytes: Uint8Array,
  contentType?: string | null,
): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 && // P
    bytes[2] === 0x4e && // N
    bytes[3] === 0x47 // G
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 // 8
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  const header = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const known = SUPPORTED_IMAGE_MEDIA_TYPES.find((t) => t === header);
  return known ?? null;
}

/** A FetchedImage as an Anthropic base64 image content block. */
export function base64ImageBlock(image: FetchedImage): Anthropic.ImageBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createImageFetcher(options: ImageFetcherOptions = {}): ImageFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_IMAGE_FETCH_ATTEMPTS);
  const minDelayMs = options.minDelayMs ?? defaultImageFetchDelayMs();
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_IMAGE_CACHE_BYTES;
  const userAgent = options.userAgent ?? hemlineImageUserAgent();
  const sleep = options.sleep ?? defaultSleep;

  const stats: ImageFetcherStats = { fetches: 0, cacheHits: 0, failures: 0 };

  // LRU by insertion order (Map preserves it; refresh on hit), byte-capped.
  const cache = new Map<string, FetchedImage>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<ImageFetchResult>>();
  const hostLastRequestAt = new Map<string, number>();

  function cachePut(url: string, image: FetchedImage): void {
    if (image.bytes > maxCacheBytes) return;
    if (cache.has(url)) return;
    cache.set(url, image);
    cacheBytes += image.bytes;
    for (const [oldUrl, old] of cache) {
      if (cacheBytes <= maxCacheBytes) break;
      cache.delete(oldUrl);
      cacheBytes -= old.bytes;
    }
  }

  async function politeDelay(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return; // malformed URL — the fetch itself will produce the real error
    }
    const wait = (hostLastRequestAt.get(host) ?? 0) + minDelayMs - Date.now();
    hostLastRequestAt.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
  }

  /** Read the body with the size cap enforced mid-stream. */
  async function readCapped(res: Response): Promise<Uint8Array | 'too_large'> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.byteLength > maxBytes ? 'too_large' : buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  async function fetchOnce(url: string): Promise<ImageFetchResult> {
    let lastDetail = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(Math.max(minDelayMs, 500) * attempt);
      await politeDelay(url);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { 'user-agent': userAgent, accept: 'image/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastDetail = (err as Error).message || String(err);
        continue; // network error / timeout — retryable
      }
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`;
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < attempts) continue;
        return { ok: false, reason: 'http_error', detail: `HTTP ${res.status}` };
      }
      let body: Uint8Array | 'too_large';
      try {
        body = await readCapped(res);
      } catch (err) {
        lastDetail = (err as Error).message || String(err);
        continue; // body stream died — retryable
      }
      if (body === 'too_large') {
        return {
          ok: false,
          reason: 'too_large',
          detail: `image exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB cap`,
        };
      }
      const mediaType = sniffImageMediaType(body, res.headers.get('content-type'));
      if (mediaType === null) {
        return {
          ok: false,
          reason: 'unsupported_media_type',
          detail: `not a supported image (content-type: ${res.headers.get('content-type') ?? 'none'})`,
        };
      }
      const image: FetchedImage = {
        base64: Buffer.from(body).toString('base64'),
        mediaType,
        bytes: body.byteLength,
      };
      cachePut(url, image);
      return { ok: true, image };
    }
    return {
      ok: false,
      reason: 'network_error',
      detail: `${lastDetail || 'download failed'} (${attempts} attempt(s))`,
    };
  }

  return {
    stats,
    async fetchImage(url: string): Promise<ImageFetchResult> {
      const cached = cache.get(url);
      if (cached) {
        // refresh LRU recency
        cache.delete(url);
        cache.set(url, cached);
        stats.cacheHits += 1;
        return { ok: true, image: cached };
      }
      const pending = inflight.get(url);
      if (pending) return pending;
      stats.fetches += 1;
      const task = fetchOnce(url)
        .then((result) => {
          if (!result.ok) stats.failures += 1;
          return result;
        })
        .finally(() => inflight.delete(url));
      inflight.set(url, task);
      return task;
    },
  };
}
