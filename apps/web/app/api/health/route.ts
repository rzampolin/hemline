/**
 * GET /api/health — deployment health probe (Fly.io http checks + `docker
 * run` smoke tests hit this). No auth, no secrets, cheap enough to poll.
 *
 * Reports:
 *  - db: reachable + listing/vector counts (a fresh empty volume is healthy —
 *    getDb() runs ensureSchema, so a brand-new file still answers `ok`)
 *  - lastIngest: most recent ingest_runs row + age (null before first run)
 *  - ml: whether the FashionSigLIP sidecar could be spawned in THIS container
 *    (false in the default prod image — visual probe search degrades to the
 *    attribute path; stored vectors still power ranking; by design, see
 *    docs/decisions-deploy.md)
 */
import { desc, isNull, sql } from 'drizzle-orm';
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import { embeddingStats, ingestRuns, listings } from '@hemline/db';
import { isEmbedderAvailable } from '@hemline/matching/embedder';
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
      ml: { sidecarAvailable: isEmbedderAvailable() },
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) {
    // db unreachable / corrupt — fail the health check so Fly restarts us
    console.error('[api:health]', err);
    return fail('unhealthy', err instanceof Error ? err.message : 'health check failed', 503);
  }
}
