/**
 * GET /api/profile  — current profile (no minting; 401 without a session).
 * PATCH /api/profile — BoundedProfilePatchSchema (Zod-pruned
 * Partial<UserProfile> with sanity bounds on height/sizes/budget — QA P1 #2;
 * id never patchable) → UserProfile. Onboarding writes here incrementally.
 */
import { BoundedProfilePatchSchema } from '@hemline/contracts';
import { getUserProfile, patchUserProfile } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { requireUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    const profile = getUserProfile(db, userId);
    if (!profile) return fail('not_found', 'profile not found', 404);
    return ok(profile);
  } catch (err) {
    return serverError('profile', err);
  }
}

export async function PATCH(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = BoundedProfilePatchSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    return ok(patchUserProfile(db, userId, parsed.data));
  } catch (err) {
    return serverError('profile', err);
  }
}
