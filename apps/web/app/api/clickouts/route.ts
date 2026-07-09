/**
 * POST /api/clickouts — affiliate click/attribution log (spec G4; additive
 * route, 2026-07-08 QA P1 #4).
 *
 * Fired fire-and-forget (sendBeacon) from the outbound "Shop on …" CTA.
 * - Guests are tolerated: no session → user_id NULL, still recorded.
 * - sourceId + destination are derived server-side from the listing row
 *   (client can't spoof attribution); destination stored as sha256 only.
 * - Unknown listing → standard not_found envelope (the click is meaningless
 *   without a listing to attribute it to).
 */
import { ClickoutPostSchema } from '@hemline/contracts';
import { enqueueVerification, recordClickout, userExists } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { resolveUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = getDb();
    let body: unknown;
    try {
      // sendBeacon may ship text/plain — Request.json() parses regardless.
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = ClickoutPostSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);

    // Session optional (guest clickouts count too); only attribute ids that
    // actually exist so an unadopted header UUID doesn't fabricate a user.
    const maybeUserId = resolveUserId(req);
    const userId = maybeUserId && userExists(db, maybeUserId) ? maybeUserId : null;

    const recorded = recordClickout(db, parsed.data.listingId, userId);
    if (!recorded) return fail('not_found', `listing ${parsed.data.listingId} not found`, 404);
    try {
      // Sold-detection: a click = user interest = highest staleness cost, so
      // queue this listing for an availability re-check (the ingest scheduler
      // drains the queue every ~15 min). Never fails the clickout.
      enqueueVerification(db, parsed.data.listingId, 'clickout');
    } catch (e) {
      console.warn('[clickouts] verification enqueue failed (clickout still recorded):', e);
    }
    return ok({ recorded: true });
  } catch (err) {
    return serverError('clickouts', err);
  }
}
