/**
 * Alerts — spec F4 STUB ONLY: toggle + preference storage in a
 * `pending_alerts` table. NO alert emails are sent in MVP; the UI shows
 * "Alerts coming soon — you're on the list."
 *
 * GET  /api/alerts → { alerts: PendingAlert[] }
 * POST /api/alerts { kind, enabled, listingId? , search? } → { alert }
 *   kind: price_drop | low_stock (listing alerts) | new_matches (saved search).
 */
import { z } from 'zod';
import { listAlerts, toggleAlert } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { requireUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AlertPostSchema = z
  .object({
    kind: z.enum(['price_drop', 'low_stock', 'new_matches']),
    enabled: z.boolean(),
    listingId: z.string().min(1).optional(),
    /** saved-search payload for new_matches alerts (opaque JSON) */
    search: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => (v.kind === 'new_matches' ? v.search != null : v.listingId != null), {
    message: 'listing alerts need listingId; new_matches needs search',
  });

export async function GET(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    return ok({ alerts: listAlerts(db, userId) });
  } catch (err) {
    return serverError('alerts', err);
  }
}

export async function POST(req: Request) {
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
    const parsed = AlertPostSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const p = parsed.data;
    const alert = toggleAlert(db, userId, {
      kind: p.kind,
      enabled: p.enabled,
      listingId: p.listingId ?? null,
      searchJson: p.search ? JSON.stringify(p.search) : null,
    });
    return ok({ alert, note: 'Alerts coming soon — stored only, no emails are sent in MVP.' });
  } catch (err) {
    return serverError('alerts', err);
  }
}
