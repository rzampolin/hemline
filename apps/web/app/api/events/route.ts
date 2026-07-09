/**
 * POST /api/events — first-party product analytics sink (additive, 2026-07-09).
 *
 * Mirrors the clickouts pattern: fire-and-forget sendBeacon (text/plain JSON
 * framing tolerated), guest-tolerant (no session → user_id NULL, anon_id
 * only), zod-validated against the CLOSED event whitelist in
 * @hemline/contracts (unknown types / junk props / oversized batches are
 * rejected — there is no open-ended tracking channel).
 *
 * Success is a silent 204 (sendBeacon never reads the body). Cheap inserts:
 * one multi-row INSERT per batch, batch capped at ANALYTICS_MAX_BATCH, raw
 * body capped before parse. Rate limiting drops excess batches silently
 * (204) — analytics must never surface errors to the UX.
 */
import { ANALYTICS_MAX_BODY_BYTES, AnalyticsBatchSchema } from '@hemline/contracts';
import { insertAnalyticsEvents, userExists } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, serverError, zodFail } from '../lib/envelope';
import { checkRateLimit } from '../lib/rate-limit';
import { resolveUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    // pre-parse size guard — analytics bodies are small by construction
    const raw = await req.text();
    if (raw.length > ANALYTICS_MAX_BODY_BYTES) {
      return fail('payload_too_large', 'analytics batch exceeds size cap', 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = AnalyticsBatchSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const { anonId, events } = parsed.data;

    // Session optional (guests count); only attribute ids that actually exist
    // so an unadopted header UUID doesn't fabricate a user (clickouts pattern).
    const db = getDb();
    const maybeUserId = resolveUserId(req);
    const userId = maybeUserId && userExists(db, maybeUserId) ? maybeUserId : null;

    // Per-client budget: excess batches are DROPPED silently (still 204) —
    // analytics never turns into a visible error or a retry storm.
    if (checkRateLimit('analytics', userId ?? anonId, 30)) {
      insertAnalyticsEvents(
        db,
        events.map((e) => ({ userId, anonId, eventType: e.type, props: e.props })),
      );
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError('events', err);
  }
}
