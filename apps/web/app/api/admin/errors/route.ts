/**
 * GET /api/admin/errors — server-side error groups for the admin Errors
 * panel (ops, 2026-07-13). Read-only over the `app_errors` table: deduped
 * groups (route, latest message/stack, count, first/last seen) ordered by
 * last-seen, plus the cheap stats aggregate the health endpoint shares.
 *
 * Auth: HTTP Basic via ADMIN_BASIC_AUTH, same as every /api/admin/* route.
 * `?limit=` caps rows (default 50, max 200).
 */
import { appErrorStats, listAppErrors } from '@hemline/db';
import { checkAdminAuth } from '../../lib/admin-auth';
import { getDb } from '../../lib/db';
import { fail, ok, serverError } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const db = getDb();
    const raw = Number(new URL(req.url).searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;
    return ok({
      errors: listAppErrors(db, { limit }),
      stats: appErrorStats(db),
    });
  } catch (err) {
    return serverError('admin/errors', err);
  }
}
