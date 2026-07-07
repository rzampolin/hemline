/**
 * GET /api/session — mints anonymous user + signed httpOnly cookie on first
 * hit → UserProfile (ARCHITECTURE §4.7, spec A2 local-first profile).
 * Accepts the client's localStorage UUID via `x-hemline-user-id` and adopts it.
 */
import { getUserProfile } from '@hemline/db';
import { getDb } from '../lib/db';
import { ok, serverError } from '../lib/envelope';
import { attachSessionCookie, ensureSessionUser } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const db = getDb();
    const { userId, isNew } = ensureSessionUser(req, db);
    const profile = getUserProfile(db, userId);
    if (!profile) return serverError('session', new Error('profile missing after mint'));
    const res = ok(profile);
    if (isNew) attachSessionCookie(res, userId);
    return res;
  } catch (err) {
    return serverError('session', err);
  }
}
