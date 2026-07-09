/**
 * Tiny first-party analytics client (additive, 2026-07-09).
 *
 * `track(event)` queues a whitelisted event (typed against
 * @hemline/contracts AnalyticsEventSchema — you cannot invent event types at
 * a call site) and flushes batches to POST /api/events:
 *  - on an interval (so long sessions still report),
 *  - when the queue reaches the batch cap,
 *  - on pagehide/visibilitychange via sendBeacon (plain-text JSON framing,
 *    same pattern as clickouts — survives navigation/tab close).
 *
 * Absolutely fire-and-forget: SSR-safe, never throws, never blocks UX,
 * failures drop the batch (analytics loss is acceptable; UX jank is not).
 * No-op in mock mode. Identity: a per-browsing-session anon id
 * (sessionStorage uuid); the server attaches user_id only when a valid
 * session accompanies the beacon (see docs/decisions-analytics.md).
 */
import { ANALYTICS_MAX_BATCH, type AnalyticsEvent } from '@hemline/contracts';
import { MOCK_MODE } from './api';

const ENDPOINT = '/api/events';
const FLUSH_INTERVAL_MS = 10_000;
const ANON_KEY = 'hemline:anon:v1';

let queue: AnalyticsEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;

function anonId(): string {
  try {
    let id = window.sessionStorage.getItem(ANON_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // private mode / storage denied — stable per-page-load fallback
    return fallbackAnonId;
  }
}
const fallbackAnonId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'anon-nostorage';

function send(events: AnalyticsEvent[], useBeacon: boolean): void {
  const payload = JSON.stringify({ anonId: anonId(), events });
  try {
    // plain string body → text/plain framing; the route parses it regardless
    if (useBeacon && navigator.sendBeacon?.(ENDPOINT, payload)) return;
  } catch {
    /* fall through to fetch */
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function flush(useBeacon = false): void {
  while (queue.length > 0) {
    send(queue.slice(0, ANALYTICS_MAX_BATCH), useBeacon);
    queue = queue.slice(ANALYTICS_MAX_BATCH);
  }
}

function bind(): void {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/** Queue a whitelisted product-analytics event. Fire-and-forget. */
export function track(event: AnalyticsEvent): void {
  if (MOCK_MODE || typeof window === 'undefined') return;
  try {
    queue.push(event);
    bind();
    if (queue.length >= ANALYTICS_MAX_BATCH) flush();
    if (!timer) {
      timer = setInterval(() => {
        if (queue.length > 0) flush();
      }, FLUSH_INTERVAL_MS);
    }
  } catch {
    /* analytics must never break the app */
  }
}

/** test hook */
export function __resetAnalytics(): void {
  queue = [];
  if (timer) clearInterval(timer);
  timer = null;
}
