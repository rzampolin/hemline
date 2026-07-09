/**
 * In-memory sliding-window rate limiter for the AI-spending endpoints
 * (find-similar, color-analysis, rank with personalize).
 *
 * Deliberately simple (deploy hardening, 2026-07-08): production runs as ONE
 * Fly machine (SQLite single-writer constraint), so per-process memory IS
 * global state. If the app ever scales to multiple machines this moves to a
 * shared store — but so does the database, so this is not the first blocker.
 *
 * Active only when NODE_ENV=production (or RATE_LIMIT_FORCE=1 for testing):
 * dev/demo/vitest flows and the parallel QA suites stay unthrottled. The
 * AI_DAILY_BUDGET_USD cost meter in packages/ai remains the hard spend cap;
 * this limiter just stops one client from burning the whole daily budget.
 */

interface Window {
  /** epoch-ms timestamps of accepted requests, oldest first */
  hits: number[];
}

const WINDOW_MS = 60_000;
const buckets = new Map<string, Window>();

/** periodic sweep so idle keys don't accumulate forever */
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 5 * WINDOW_MS) return;
  lastSweep = now;
  for (const [key, w] of buckets) {
    if (w.hits.length === 0 || w.hits[w.hits.length - 1] < now - WINDOW_MS) buckets.delete(key);
  }
}

function limitFor(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function rateLimitEnabled(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.RATE_LIMIT_FORCE === '1';
}

/**
 * Record a hit for `key` under `bucket`; true → allowed, false → limited.
 * Default budgets (per key, per minute; override via RATE_LIMIT_AI_RPM):
 * generous for a human, tight for a loop.
 */
export function checkRateLimit(bucket: string, key: string, perMinute?: number): boolean {
  if (!rateLimitEnabled()) return true;
  const limit = perMinute ?? limitFor('RATE_LIMIT_AI_RPM', 20);
  const now = Date.now();
  sweep(now);
  const id = `${bucket}:${key}`;
  const w = buckets.get(id) ?? { hits: [] };
  w.hits = w.hits.filter((t) => t > now - WINDOW_MS);
  if (w.hits.length >= limit) {
    buckets.set(id, w);
    return false;
  }
  w.hits.push(now);
  buckets.set(id, w);
  return true;
}

/** test hook */
export function __resetRateLimiter(): void {
  buckets.clear();
  lastSweep = 0;
}
