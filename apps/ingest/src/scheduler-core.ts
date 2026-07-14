/**
 * Scheduler tick plumbing — extracted from schedule.ts after the 2026-07-10
 * outage (docs/decisions-scheduler.md) so every hazard is unit-testable:
 *
 * 1. createTickChain(): the ONE way ticks append to the serialization chain.
 *    Every link is `.then(fn).catch(log)` — a throwing/rejecting tick body can
 *    NEVER poison the chain (the old code called shouldRunConnector outside
 *    try/catch; one SQLITE_BUSY throw rejected the chain and every later
 *    `.then(onFulfilled)` silently never ran again).
 * 2. runConnectorTick(): gate + pipeline INSIDE the protected body, plus a
 *    WATCHDOG timeout (INGEST_TICK_TIMEOUT_MS, default 2h) so a hung await
 *    (dead socket, wedged ML sidecar) can never freeze the chain forever.
 * 3. sweepZombieRuns(): boot-time self-heal for ingest_runs rows stuck in
 *    status='running' (a killed process never runs finalize()).
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Logger, SourceConnector } from '@hemline/contracts';
import { ingestRuns, type Db } from '@hemline/db';
import { consoleLogger, runPipeline, type PipelineResult } from './pipeline';
import { shouldRunConnector } from './sources';

/* ── 1. poison-proof serialization chain ───────────────────────────────── */

export interface TickChain {
  /** Append a tick. `fn` runs after every previously enqueued tick settles. */
  enqueue(label: string, fn: () => Promise<unknown> | unknown): void;
  /** Settles when everything enqueued so far has finished (tests). */
  whenIdle(): Promise<void>;
}

/**
 * Serialize ticks so crawls never overlap (politeness, single SQLite writer),
 * with the invariant the incident violated: the chain promise ALWAYS resolves.
 * Failures are logged and swallowed at the link — never propagated into the
 * next `.then`.
 */
export function createTickChain(logger: Logger = consoleLogger): TickChain {
  let chain: Promise<void> = Promise.resolve();
  return {
    enqueue(label, fn) {
      chain = chain
        .then(async () => {
          await fn();
        })
        .catch((e) => {
          // last line of defense — tick bodies do their own catching, but a
          // rejection here must terminate at this link, not poison the chain
          logger.error(`[ingest:watch] ${label} tick failed (chain continues):`, e);
        });
    },
    whenIdle() {
      return chain;
    },
  };
}

/* ── 2. watchdog-guarded connector tick ────────────────────────────────── */

/** 2h default: a monster store legitimately takes ~1h end to end. */
export const DEFAULT_TICK_TIMEOUT_MS = 2 * 60 * 60_000;

export function tickTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INGEST_TICK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICK_TIMEOUT_MS;
}

export type TickOutcome = 'ran' | 'skipped' | 'failed' | 'timeout';

export interface ConnectorTickOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** watchdog budget for one tick; default tickTimeoutMs(env) */
  timeoutMs?: number;
  /** test seams */
  gate?: typeof shouldRunConnector;
  runPipelineImpl?: (db: Db, connector: SourceConnector) => Promise<PipelineResult>;
  now?: () => number;
  /** heartbeat hook — called when a tick actually starts a pipeline run */
  onRun?: (sourceId: string) => void;
}

/**
 * One scheduled ingest tick. NEVER rejects (returns an outcome instead):
 * - the shouldRunConnector gate runs inside the same try/catch as the crawl
 *   (a SQLITE_BUSY here is a skipped tick, not a poisoned chain);
 * - the pipeline is raced against a watchdog. On timeout the tick resolves so
 *   later ticks proceed; the abandoned run's promise keeps running DETACHED
 *   (observed, so its rejection can't become unhandled). That is safe: the
 *   pipeline is idempotent per content_hash, pruning is recomputed each run,
 *   and its ingest_runs row is marked error='watchdog timeout' below — if the
 *   detached run does finish later, finalize() overwrites that marker with
 *   the real outcome, which is the honest record.
 */
export async function runConnectorTick(
  db: Db,
  connector: SourceConnector,
  opts: ConnectorTickOptions = {},
): Promise<TickOutcome> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? tickTimeoutMs(env);

  let gate: ReturnType<typeof shouldRunConnector>;
  try {
    gate = (opts.gate ?? shouldRunConnector)(db, connector, env);
  } catch (e) {
    logger.error(
      `[ingest:watch] ${connector.id} pre-run gate threw (tick skipped, chain continues):`,
      e,
    );
    return 'failed';
  }
  if (!gate.run) {
    logger.info(`[ingest:watch] ${connector.id} ${gate.reason} — tick skipped`);
    return 'skipped';
  }

  opts.onRun?.(connector.id);
  const tickStartedAt = now();

  // Observe the pipeline promise up front: even if the watchdog abandons it,
  // a late rejection is logged — never an unhandledRejection process crash.
  const observed: Promise<{ kind: 'ok' } | { kind: 'error'; error: unknown }> = Promise.resolve()
    .then(() => (opts.runPipelineImpl ?? runPipeline)(db, connector))
    .then(
      () => ({ kind: 'ok' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );

  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs);
    timer.unref?.();
  });

  const outcome = await Promise.race([observed, watchdog]);
  clearTimeout(timer);

  if (outcome.kind === 'timeout') {
    logger.error(
      `[ingest:watch] WATCHDOG: ${connector.id} tick still running after ${Math.round(timeoutMs / 60_000)}min — ` +
        `abandoning it so later ticks can proceed (run row marked error='watchdog timeout'; ` +
        `raise INGEST_TICK_TIMEOUT_MS if this store legitimately needs longer)`,
    );
    const marked = markAbandonedRuns(db, connector.id, tickStartedAt, now());
    if (marked === 0) {
      logger.warn(
        `[ingest:watch] WATCHDOG: no running ingest_runs row found for ${connector.id} — ` +
          `the tick hung before/without recording a run`,
      );
    }
    void observed.then((late) => {
      if (late.kind === 'error') {
        logger.error(`[ingest:watch] ${connector.id} failed AFTER watchdog abandon:`, late.error);
      } else {
        logger.warn(
          `[ingest:watch] ${connector.id} eventually completed after watchdog abandon — ` +
            `its run row reflects the real outcome`,
        );
      }
    });
    return 'timeout';
  }

  if (outcome.kind === 'error') {
    logger.error(`[ingest:watch] ${connector.id} failed:`, outcome.error);
    return 'failed';
  }
  return 'ran';
}

/** Mark this tick's still-'running' run row(s) as watchdog-abandoned. */
export function markAbandonedRuns(
  db: Db,
  sourceId: string,
  sinceMs: number,
  nowMs: number,
): number {
  return db
    .update(ingestRuns)
    .set({ status: 'error', error: 'watchdog timeout', finishedAt: nowMs })
    .where(
      and(
        eq(ingestRuns.sourceId, sourceId),
        eq(ingestRuns.status, 'running'),
        gte(ingestRuns.startedAt, sinceMs),
      ),
    )
    .run().changes;
}

/* ── 3. zombie run self-heal ───────────────────────────────────────────── */

export const DEFAULT_ZOMBIE_MAX_AGE_HOURS = 6;

export function zombieMaxAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INGEST_ZOMBIE_MAX_AGE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ZOMBIE_MAX_AGE_HOURS;
}

/**
 * Boot-time sweep: any ingest_runs row still status='running' after N hours
 * (default 6 — no legitimate run takes that long; watchdog caps ticks at 2h)
 * belongs to a killed process and is closed as an error so dashboards and the
 * per-source staleness alert see the truth instead of an eternal 'running'.
 */
export function sweepZombieRuns(
  db: Db,
  opts: { maxAgeMs?: number; now?: number; env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): number {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? zombieMaxAgeHours(opts.env) * 3_600_000;
  const swept = db
    .update(ingestRuns)
    .set({ status: 'error', error: 'zombie: swept at boot', finishedAt: now })
    .where(and(eq(ingestRuns.status, 'running'), lte(ingestRuns.startedAt, now - maxAgeMs)))
    .run().changes;
  if (swept > 0) {
    (opts.logger ?? consoleLogger).warn(
      `[ingest:watch] swept ${swept} zombie run(s) stuck in status='running' > ${Math.round(maxAgeMs / 3_600_000)}h (marked error='zombie: swept at boot')`,
    );
  }
  return swept;
}
