/**
 * POST /api/swipes — SwipeEvent[] → { styleTags }.
 * Records events and updates the learned style vector inline (§4.7).
 * verdict='save' also lands on the rack (saves are save-verdict swipe rows).
 */
import { SwipesPostSchema, type SwipesPostResponse } from '@hemline/contracts';
import { attributeVectorsFor, getUserProfile, recordSwipes, setStyleTags } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { checkRateLimit } from '../lib/rate-limit';
import { requireUserId } from '../lib/session';
import { applySwipesToStyleTags } from '../lib/style-learning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    // DB-write abuse guard (each POST records events + recomputes style tags).
    if (!checkRateLimit('swipes', userId, 120)) {
      return fail('rate_limited', 'Too many swipes — slow down for a minute', 429);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = SwipesPostSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const events = parsed.data;

    recordSwipes(db, userId, events);

    const profile = getUserProfile(db, userId);
    if (!profile) return fail('not_found', 'profile not found', 404);
    const vectors = attributeVectorsFor(db, events.map((e) => e.listingId));
    const styleTags = applySwipesToStyleTags(profile.styleTags, events, vectors);
    setStyleTags(db, userId, styleTags);

    const data: SwipesPostResponse = { styleTags };
    return ok(data);
  } catch (err) {
    return serverError('swipes', err);
  }
}
