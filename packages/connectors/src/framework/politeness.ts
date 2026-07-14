/**
 * Politeness layer — per-host rate limit (≥1s between requests/host, configurable
 * via HEMLINE_CRAWL_DELAY_MS) and an identified User-Agent. docs/ARCHITECTURE.md §8.
 *
 * All connector HTTP goes through `politeFetch`: requests to the same host are
 * serialized on a per-host queue with a minimum delay between them, carry the
 * SolineBot User-Agent, and get one retry with backoff on 429/5xx.
 */

export function hemlineUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return `SolineBot/1.0 (+${env.CRAWLER_CONTACT ?? 'rzampolin15@gmail.com'})`;
}

export function defaultCrawlDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.HEMLINE_CRAWL_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

export interface PolitenessOptions {
  /** minimum ms between requests to the same host (default: HEMLINE_CRAWL_DELAY_MS or 1000) */
  minDelayMs?: number;
  /** retries on 429/5xx (default 1) */
  retries?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** host → tail of the request chain (serializes requests per host) */
const hostQueues = new Map<string, Promise<unknown>>();
/** host → epoch ms of the last request start */
const hostLastRequestAt = new Map<string, number>();

/** Test hook: forget per-host timing state. */
export function resetPoliteness(): void {
  hostQueues.clear();
  hostLastRequestAt.clear();
}

export async function politeFetch(
  url: string,
  init?: RequestInit,
  opts: PolitenessOptions = {},
): Promise<Response> {
  const host = new URL(url).host;
  const minDelayMs = opts.minDelayMs ?? defaultCrawlDelayMs();
  const retries = opts.retries ?? 1;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const prev = hostQueues.get(host) ?? Promise.resolve();
  const task = prev
    .catch(() => undefined) // one failed request must not poison the host queue
    .then(async () => {
      const headers = new Headers(init?.headers);
      if (!headers.has('user-agent')) headers.set('user-agent', hemlineUserAgent());

      let attempt = 0;
      for (;;) {
        const wait = (hostLastRequestAt.get(host) ?? 0) + minDelayMs - Date.now();
        if (wait > 0) await sleep(wait);
        hostLastRequestAt.set(host, Date.now());

        const res = await fetchImpl(url, { ...init, headers });
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) return res;
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : Math.max(minDelayMs, 1000) * 2 * attempt;
        await sleep(backoff);
      }
    });
  hostQueues.set(host, task);
  return task as Promise<Response>;
}
