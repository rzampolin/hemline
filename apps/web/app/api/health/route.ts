/**
 * GET /api/health — deployment health probe (Fly.io http checks + `docker
 * run` smoke tests hit this). No auth, no secrets, cheap enough to poll.
 *
 * Reports:
 *  - db: reachable + listing/vector counts (a fresh empty volume is healthy —
 *    getDb() runs ensureSchema, so a brand-new file still answers `ok`)
 *  - lastIngest: most recent ingest_runs row + age (null before first run)
 *  - ml: honest sidecar readiness in THIS container. The prod image bakes the
 *    FashionSigLIP venv + weights and eager-loads at boot (HEMLINE_ML_EAGER=1,
 *    docs/decisions-deploy.md): `state` walks warming → ready and
 *    `sidecarAvailable` flips true when the model is actually resident.
 *    Local dev without `npm run ml:setup` reports unavailable/false — visual
 *    probe search degrades to the attribute path; stored vectors still power
 *    ranking either way.
 */
import { desc, isNull, sql } from 'drizzle-orm';
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import { embeddingStats, ingestRuns, listings } from '@hemline/db';
import { sidecarStatus } from '@hemline/matching/embedder';
import { getDb } from '../lib/db';
import { fail, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = getDb();

    const listingCount =
      db
        .select({ n: sql<number>`count(*)` })
        .from(listings)
        .where(isNull(listings.removedAt))
        .get()?.n ?? 0;

    const lastRun = db
      .select({
        sourceId: ingestRuns.sourceId,
        startedAt: ingestRuns.startedAt,
        finishedAt: ingestRuns.finishedAt,
        status: ingestRuns.status,
      })
      .from(ingestRuns)
      .orderBy(desc(ingestRuns.startedAt))
      .limit(1)
      .get();

    const vectors = embeddingStats(db, EMBEDDING_MODEL_TAG);
    const ml = sidecarStatus();
    const now = Date.now();

    return ok({
      status: 'ok' as const,
      db: { reachable: true, listingCount, vectorCount: vectors.count },
      lastIngest: lastRun
        ? {
            sourceId: lastRun.sourceId,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            ageSeconds: Math.round((now - lastRun.startedAt) / 1000),
          }
        : null,
      ml: { sidecarAvailable: ml.available, state: ml.state },
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) {
    // db unreachable / corrupt — fail the health check so Fly restarts us
    console.error('[api:health]', err);
    return fail('unhealthy', err instanceof Error ? err.message : 'health check failed', 503);
  }
}
