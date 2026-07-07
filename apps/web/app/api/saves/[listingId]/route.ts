/**
 * DELETE /api/saves/:listingId — unsave (spec F1 one-tap save/unsave).
 * Idempotent: unsaving something not saved still returns ok.
 */
import { unsaveListing } from '@hemline/db';
import { getDb } from '../../lib/db';
import { fail, ok, serverError } from '../../lib/envelope';
import { requireUserId } from '../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, ctx: { params: Promise<{ listingId: string }> }) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    const { listingId } = await ctx.params;
    unsaveListing(db, userId, decodeURIComponent(listingId));
    return ok({ saved: false });
  } catch (err) {
    return serverError('saves/:listingId', err);
  }
}
