/**
 * Admin ingestion (spec G1 + §4.7).
 *
 * GET  /api/admin/ingest → { sources: SourceHealth[] } — per source: last run,
 *   fetched/error stats, error-run count, listing counts + staleness buckets.
 * POST /api/admin/ingest { sourceId? } → { runId } — dev-convenience trigger.
 *   The real pipeline lives in apps/ingest (data-eng); until it's importable
 *   from the web app this records the requested run as status='error' with a
 *   `not_implemented` note so the trigger is visible in G1. Integration:
 *   swap `triggerIngest` to call the shared pipeline entrypoint.
 *
 * Auth: HTTP Basic when ADMIN_BASIC_AUTH="user:pass" is set (spec G1).
 */
import { AdminIngestRequestSchema, type AdminIngestResponse } from '@hemline/contracts';
import { ingestionHealth, insertIngestRun, listSourceIds } from '@hemline/db';
import { checkAdminAuth } from '../../lib/admin-auth';
import { getDb } from '../../lib/db';
import { fail, ok, serverError, zodFail } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    return ok({ sources: ingestionHealth(getDb()) });
  } catch (err) {
    return serverError('admin/ingest', err);
  }
}

export async function POST(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const db = getDb();
    let body: unknown = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = AdminIngestRequestSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);

    const sourceId = parsed.data.sourceId ?? listSourceIds(db)[0];
    if (!sourceId) return fail('not_found', 'no sources configured', 404);

    const now = Date.now();
    const runId = insertIngestRun(db, {
      sourceId,
      startedAt: now,
      finishedAt: now,
      status: 'error',
      stats: { fetched: 0, new: 0, updated: 0, unchanged: 0, errors: 1 },
      error:
        'not_implemented: one-shot ingest pipeline is apps/ingest (data-eng); ' +
        'run `npm run ingest` instead. Trigger recorded for G1 visibility.',
    });
    const data: AdminIngestResponse = { runId };
    return ok(data);
  } catch (err) {
    return serverError('admin/ingest', err);
  }
}
