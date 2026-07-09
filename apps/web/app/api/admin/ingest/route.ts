/**
 * Admin ingestion (spec G1 + §4.7).
 *
 * GET  /api/admin/ingest → { sources: SourceHealth[] } — per source: last run,
 *   fetched/error stats, error-run count, listing counts + staleness buckets.
 * POST /api/admin/ingest { sourceId? } → { runId } — triggers the REAL shared
 *   pipeline (@hemline/ingest, integration 2026-07-06). A trigger row is
 *   recorded immediately and updated when the run completes. Local/fixture
 *   sources run to completion before responding (fast, deterministic);
 *   network sources (ebay / shopify crawls) run fire-and-forget so the
 *   request never hangs on a crawl.
 *
 * Auth: HTTP Basic when ADMIN_BASIC_AUTH="user:pass" is set (spec G1).
 */
import { AdminIngestRequestSchema, type AdminIngestResponse } from '@hemline/contracts';
import { runIngestForSource, type IngestRunOutcome } from '@hemline/ingest';
import {
  clickoutStats,
  ingestionHealth,
  insertIngestRun,
  listSourceIds,
  ingestRuns,
  type Db,
} from '@hemline/db';
import { eq } from 'drizzle-orm';
import { checkAdminAuth } from '../../lib/admin-auth';
import { getDb } from '../../lib/db';
import { fail, ok, serverError, zodFail } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const db = getDb();
    // `clickouts` is additive (spec G4, 2026-07-08): outbound-CTA attribution
    // counts — total / last-24h / per-source — next to ingest health.
    return ok({ sources: ingestionHealth(db), clickouts: clickoutStats(db) });
  } catch (err) {
    return serverError('admin/ingest', err);
  }
}

function finishTriggerRun(db: Db, runId: number, outcome: IngestRunOutcome): void {
  db.update(ingestRuns)
    .set({
      finishedAt: Date.now(),
      status: outcome.status,
      statsJson: JSON.stringify({ ...outcome.stats, trigger: 'admin' }),
      error:
        outcome.status === 'error'
          ? (outcome.results.find((r) => r.error)?.error ?? 'ingest failed')
          : null,
    })
    .where(eq(ingestRuns.id, runId))
    .run();
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

    // Trigger row: visible in G1 immediately, updated on completion.
    const runId = insertIngestRun(db, {
      sourceId,
      startedAt: Date.now(),
      status: 'running',
      stats: { trigger: 'admin' },
    });

    const isLocal = sourceId === 'fixtures' || sourceId.startsWith('fixture');
    const run = runIngestForSource(db, sourceId)
      .then((outcome) => finishTriggerRun(db, runId, outcome))
      .catch((e: unknown) => {
        db.update(ingestRuns)
          .set({
            finishedAt: Date.now(),
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
          })
          .where(eq(ingestRuns.id, runId))
          .run();
      });
    if (isLocal) await run; // fixtures are fast — return a settled run

    const data: AdminIngestResponse = { runId };
    return ok(data);
  } catch (err) {
    return serverError('admin/ingest', err);
  }
}
