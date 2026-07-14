/**
 * POST /api/fit-check { url } — paste-a-dress-link (2026-07-13).
 *
 * The user pastes ANY dress PDP URL; we fetch it server-side (SSRF-guarded —
 * see lib/safe-url.ts), read the garment, and answer with HER fit check plus
 * similar in-catalog alternatives. Guests are welcome (a session is minted on
 * first paste — iOS share-sheet arrivals have no cookie yet); AI-spending
 * endpoint → prod rate limit, 10/min/user, like find-similar.
 *
 * Degradation contract: parse/fetch failures are honest 200 responses with
 * outcome 'unreadable' | 'not_a_dress' | 'child_audience' | 'blocked_url' —
 * never a 500 for a bad page, never a hang (hard timeouts throughout).
 */
import { FIT_CHECK_URL_MAX_LEN, FitCheckRequestSchema } from '@hemline/contracts';
import { getUserProfile } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { runFitCheck } from '../lib/fit-check';
import { checkRateLimit } from '../lib/rate-limit';
import { attachSessionCookie, ensureSessionUser } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = getDb();
    // guests OK: mint the session instead of 401-ing a first-touch paste
    const { userId, isNew } = ensureSessionUser(req, db);
    if (!checkRateLimit('fit-check', userId, 10)) {
      return fail('rate_limited', 'Too many link checks — try again in a minute', 429);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON: { url }', 400);
    }
    const parsed = FitCheckRequestSchema.safeParse(raw);
    if (!parsed.success) return zodFail(parsed.error);
    if (parsed.data.url.length > FIT_CHECK_URL_MAX_LEN) {
      return fail('invalid_request', 'url too long', 400);
    }

    const profile = getUserProfile(db, userId);
    const result = await runFitCheck(db, profile, parsed.data.url);

    const res = ok(result);
    if (isNew) attachSessionCookie(res, userId);
    return res;
  } catch (err) {
    return serverError('fit-check', err);
  }
}
