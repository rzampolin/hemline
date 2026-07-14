/**
 * GET /api/health — deployment health probe (Fly.io http checks, `docker
 * run` smoke tests, and the founder's external uptime monitor — docs/UPTIME.md).
 * No auth, no secrets, cheap enough to poll.
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
 *  - errors: aggregate error-tracking counts (additive, ops 2026-07-13) —
 *    group count + ~last-hour occurrences from `app_errors`. Counts only, no
 *    messages/stacks (this endpoint is public).
 *  - alerts: self-diagnosis array (additive, ops 2026-07-13; docs/UPTIME.md).
 *    Empty = nothing to flag; a keyword monitor can alert whenever the body
 *    stops containing `"alerts":[]`. Codes: ml_failed / ml_unavailable /
 *    ingest_stale / error_spike / litestream_down. "db unreachable" has no
 *    alert entry — it is the 503 path below (status != 200 IS the alert).
 *    Litestream detection reads the supervisor status file written by
 *    docker/start.mjs (fallback: the /tmp/litestream-alive heartbeat); limits
 *    are documented honestly in docs/decisions-ops.md.
 */
import fs from 'node:fs';
import { desc, isNull, sql } from 'drizzle-orm';
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import { appErrorStats, embeddingStats, ingestRuns, listings } from '@hemline/db';
import { sidecarStatus } from '@hemline/matching/embedder';
import { getDb } from '../lib/db';
import { fail, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HealthAlert {
  code: 'ml_failed' | 'ml_unavailable' | 'ingest_stale' | 'error_spike' | 'litestream_down';
  message: string;
}

interface SupervisorStatusFile {
  updatedAt?: number;
  children?: Record<
    string,
    { up?: boolean; lastExit?: { code: number | null; signal: string | null; at: number } }
  >;
}

const S3_VARS = ['BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3'];

function litestreamAlert(): HealthAlert | null {
  const expected =
    process.env.LITESTREAM_REPLICATE !== 'off' && S3_VARS.every((v) => !!process.env[v]);
  if (!expected) return null; // secrets absent → backup intentionally off (local/dev)
  const statusPath = process.env.SUPERVISOR_STATUS_FILE ?? '/tmp/hemline-supervisor.json';
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as SupervisorStatusFile;
    const child = parsed.children?.litestream;
    if (!child) {
      return { code: 'litestream_down', message: 'supervisor has never spawned litestream' };
    }
    if (child.up === false) {
      const exit = child.lastExit;
      return {
        code: 'litestream_down',
        message: `litestream child is down (exit code=${exit?.code ?? '?'} signal=${exit?.signal ?? 'none'}; supervisor restarts with backoff)`,
      };
    }
    return null;
  } catch {
    // no/unreadable status file (older image, or web run outside the
    // supervisor) — fall back to the spawn-heartbeat file
    const heartbeat = process.env.LITESTREAM_HEARTBEAT_FILE ?? '/tmp/litestream-alive';
    return fs.existsSync(heartbeat)
      ? null
      : {
          code: 'litestream_down',
          message: 'no supervisor status and no litestream heartbeat — backup child likely never started',
        };
  }
}

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
    const errors = appErrorStats(db, now);

    const alerts: HealthAlert[] = [];

    if (ml.state === 'failed') {
      alerts.push({ code: 'ml_failed', message: 'ML sidecar warmup failed — probe embedding disabled, attribute fallback active' });
    } else if (process.env.HEMLINE_ML_EAGER === '1' && ml.state === 'unavailable') {
      alerts.push({ code: 'ml_unavailable', message: 'HEMLINE_ML_EAGER=1 but the ML sidecar is not installed in this container' });
    }

    const staleHours = Number(process.env.HEALTH_INGEST_STALE_HOURS ?? 36);
    if (lastRun && now - lastRun.startedAt > staleHours * 3_600_000) {
      alerts.push({
        code: 'ingest_stale',
        message: `last ingest run started ${Math.round((now - lastRun.startedAt) / 3_600_000)}h ago (threshold ${staleHours}h)`,
      });
    }

    const spikeThreshold = Number(process.env.HEALTH_ERROR_SPIKE_THRESHOLD ?? 20);
    if (errors.lastHour >= spikeThreshold) {
      alerts.push({
        code: 'error_spike',
        message: `~${errors.lastHour} server errors in the last hour (threshold ${spikeThreshold}; details: /api/admin/errors)`,
      });
    }

    const ls = litestreamAlert();
    if (ls) alerts.push(ls);

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
      errors,
      alerts,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) {
    // db unreachable / corrupt — fail the health check so Fly restarts us
    // (and so the external uptime monitor fires on status != 200)
    console.error('[api:health]', err);
    return fail('unhealthy', err instanceof Error ? err.message : 'health check failed', 503);
  }
}
