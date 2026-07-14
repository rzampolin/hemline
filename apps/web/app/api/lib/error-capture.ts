/**
 * Server-side error capture (ops, 2026-07-13) — the one funnel into the
 * `app_errors` table (packages/db query/app-errors: dedup by stack hash,
 * bounded by prune).
 *
 * Callers: envelope.serverError (every route's catch path) and the Next
 * onRequestError instrumentation hook. MUST never throw: if the db itself is
 * down, error *reporting* silently degrades to the console.error the caller
 * already did — a capture failure must not cascade.
 */
import { recordAppError } from '@hemline/db';
import { getDb } from './db';

export function captureError(route: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? null) : null;
    recordAppError(getDb(), { route, message, stack });
  } catch {
    // db unreachable/corrupt — the health check surfaces that separately
  }
}
