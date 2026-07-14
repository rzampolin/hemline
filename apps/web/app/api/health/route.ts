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
 *    ingest_stale / error_spike / litestream_down / scheduler_dead.
 *    ingest_stale is PER-SOURCE (stalest enabled source's last successful run,
 *    docs/decisions-scheduler.md #4) — the old any-source check let the mock
 *    eBay cron mask the 2026-07-10 daily-crawl outage. scheduler_dead reads
 *    the scheduler heartbeat file + supervisor status (#5). "db unreachable"
 *    has no alert entry — it is the 503 path below (status != 200 IS the alert).
 *    Litestream detection reads the supervisor status file written by
 *    docker/start.mjs (fallback: the /tmp/litestream-alive heartbeat); limits
 *    are documented honestly in docs/decisions-ops.md.
 */
import fs from 'node:fs';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import { appErrorStats, embeddingStats, ingestRuns, listings, sources, type Db } from '@hemline/db';
import { sidecarStatus } from '@hemline/matching/embedder';
import { getDb } from '../lib/db';
import { fail, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HealthAlert {
  code:
    | 'ml_failed'
    | 'ml_unavailable'
    | 'ingest_stale'
    | 'error_spike'
    | 'litestream_down'
    | 'scheduler_dead';
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

/**
 * Per-source ingest staleness (docs/decisions-scheduler.md #4). The old check
 * ("ANY recent ingest_runs row") let the 6-hourly mock eBay cron mask a 3-day
 * outage of every daily store crawl (2026-07-10 incident). Now: every ENABLED
 * source that has ever completed a SUCCESSFUL run must have done so within
 * HEALTH_INGEST_STALE_HOURS (default 30 — daily cadence + slack); the alert
 * names the stalest source and its age. Disabled sources are ignored (the
 * admin toggle is the honest way to retire one — e.g. the banned mock eBay
 * cron), and never-succeeded sources are skipped (a brand-new source/install
 * has no cadence promise to break yet; the `lastIngest: null` payload field
 * keeps that case visible).
 */
function perSourceStaleAlert(db: Db, now: number): HealthAlert | null {
  const staleHours = Number(process.env.HEALTH_INGEST_STALE_HOURS ?? 30);
  const rows = db
    .select({
      sourceId: ingestRuns.sourceId,
      lastOkAt: sql<number>`max(${ingestRuns.startedAt})`,
    })
    .from(ingestRuns)
    .innerJoin(sources, eq(sources.id, ingestRuns.sourceId))
    .where(and(eq(sources.enabled, true), eq(ingestRuns.status, 'ok')))
    .groupBy(ingestRuns.sourceId)
    .all();
  if (rows.length === 0) return null;

  let stalest = rows[0];
  for (const row of rows) if (row.lastOkAt < stalest.lastOkAt) stalest = row;
  const ageMs = now - stalest.lastOkAt;
  if (ageMs <= staleHours * 3_600_000) return null;
  return {
    code: 'ingest_stale',
    message:
      `stalest enabled source '${stalest.sourceId}' last succeeded ${Math.round(ageMs / 3_600_000)}h ago ` +
      `(threshold ${staleHours}h; every enabled source must succeed on cadence — ` +
      `disable retired sources in the sources table)`,
  };
}

/**
 * Scheduler liveness (docs/decisions-scheduler.md #5). Two independent
 * signals, either fires `scheduler_dead`:
 *  - the supervisor status file says the scheduler child is down;
 *  - the scheduler's heartbeat file (written every ~60s by the tick loop)
 *    exists but is older than HEALTH_SCHEDULER_STALE_MINUTES (default 30) —
 *    the process is up per the supervisor yet its event loop / cron layer has
 *    silently stopped, exactly the 2026-07-10 failure shape.
 * No heartbeat file at all → no alert (web-only dev runs have no scheduler;
 * in the container the scheduler writes its first beat at boot).
 */
function schedulerAlert(now: number): HealthAlert | null {
  const status = readSupervisorStatus();
  const child = status?.children?.scheduler;
  if (child && child.up === false) {
    const exit = child.lastExit;
    return {
      code: 'scheduler_dead',
      message: `scheduler child is down (exit code=${exit?.code ?? '?'} signal=${exit?.signal ?? 'none'}; supervisor restarts with backoff)`,
    };
  }
  const hbPath = process.env.SCHEDULER_HEARTBEAT_FILE ?? '/tmp/hemline-scheduler-heartbeat.json';
  try {
    const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8')) as { updatedAt?: number };
    const staleMinutes = Number(process.env.HEALTH_SCHEDULER_STALE_MINUTES ?? 30);
    if (typeof hb.updatedAt === 'number' && now - hb.updatedAt > staleMinutes * 60_000) {
      return {
        code: 'scheduler_dead',
        message:
          `scheduler heartbeat is ${Math.round((now - hb.updatedAt) / 60_000)}min old ` +
          `(threshold ${staleMinutes}min) — the cron loop has silently stopped`,
      };
    }
  } catch {
    /* no/unreadable heartbeat — scheduler not expected in this process (dev) */
  }
  return null;
}

function readSupervisorStatus(): SupervisorStatusFile | null {
  const statusPath = process.env.SUPERVISOR_STATUS_FILE ?? '/tmp/hemline-supervisor.json';
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as SupervisorStatusFile;
  } catch {
    return null;
  }
}

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

    const stale = perSourceStaleAlert(db, now);
    if (stale) alerts.push(stale);

    const sched = schedulerAlert(now);
    if (sched) alerts.push(sched);

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
