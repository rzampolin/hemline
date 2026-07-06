/**
 * Politeness layer — per-host rate limit (≥1s between requests/host) and an
 * identified User-Agent. docs/ARCHITECTURE.md §8.
 *
 * TODO(data-eng): implement per-host queueing + delay + retry/backoff.
 */

export function hemlineUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return `HemlineBot/1.0 (+${env.CRAWLER_CONTACT ?? 'rzampolin15@gmail.com'})`;
}

export async function politeFetch(_url: string, _init?: RequestInit): Promise<Response> {
  throw new Error(
    'not yet implemented (data-eng): per-host rate-limited fetch — docs/ARCHITECTURE.md §8',
  );
}
