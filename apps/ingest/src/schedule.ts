/**
 * Long-running scheduler — `npm run ingest:watch` (or `npm run ingest -- --watch`).
 * Registers one node-cron job per source: cadence comes from the sources row
 * when present (admin-editable, product spec G3) else the connector default
 * (Shopify daily, eBay 6-hourly — docs/ARCHITECTURE.md §8).
 *
 * Also registers the sold-detection verification jobs (VERIFY_ENABLE, default
 * on): a ~15-min drain of the clickout verification queue and an hourly
 * rolling sweep of the oldest-verified active listings (verification.ts).
 *
 * Reliability invariants (post-incident 2026-07-10, docs/decisions-scheduler.md):
 * - ALL scheduled work is appended via TickChain.enqueue — a throwing gate or
 *   rejecting job can never poison the serialization chain;
 * - every ingest tick runs under a watchdog (INGEST_TICK_TIMEOUT_MS, def. 2h)
 *   so one hung await can never freeze every later tick;
 * - zombie ingest_runs rows (status='running' from a killed process) are swept
 *   to error at boot;
 * - a heartbeat file + per-day tick summary make silent cron death observable
 *   (/api/health raises `scheduler_dead`).
 */
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import type { SourceConnector } from '@hemline/contracts';
import { ensureSchema, type Db } from '@hemline/db';
import { createTickChain, runConnectorTick, sweepZombieRuns } from './scheduler-core';
import { createSchedulerHeartbeat } from './scheduler-heartbeat';
import { buildConnectors, cadenceFor, openDb, parseArgs } from './sources';
import { drainVerificationQueue, runRollingVerification, verifyEnvConfig } from './verification';

export interface ScheduledJob {
  sourceId: string;
  cadence: string;
  stop: () => void;
}

export function startScheduler(db: Db, connectors: SourceConnector[]): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  /** serialize runs so overlapping ticks (and politeness) stay sane */
  const chain = createTickChain();
  const heartbeat = createSchedulerHeartbeat();

  // self-heal: close run rows orphaned by a previous kill (finalize never ran)
  sweepZombieRuns(db);

  for (const connector of connectors) {
    const cadence = cadenceFor(db, connector);
    if (!cron.validate(cadence)) {
      console.warn(`[ingest:watch] invalid cadence '${cadence}' for ${connector.id} — skipping`);
      continue;
    }
    const task = cron.schedule(cadence, () => {
      chain.enqueue(connector.id, () =>
        runConnectorTick(db, connector, { onRun: (id) => heartbeat.recordTick(id) }),
      );
    });
    jobs.push({ sourceId: connector.id, cadence, stop: () => void task.stop() });
    console.log(`[ingest:watch] scheduled ${connector.id} @ '${cadence}'`);
  }

  // ── sold-detection verification (shares the chain so it never overlaps a crawl) ─
  const verifyCfg = verifyEnvConfig();
  if (!verifyCfg.enabled) {
    console.log('[ingest:watch] verification disabled (VERIFY_ENABLE=false)');
  } else {
    // verified_at / verification_queue are additive — make sure they exist
    // even when the scheduler ticks before the web app's lazy getDb() does.
    ensureSchema(db);
    const verifyJobs: Array<{ id: string; cadence: string; run: () => Promise<unknown> }> = [
      {
        id: 'verify:clicked',
        cadence: verifyCfg.clickCron,
        run: () => drainVerificationQueue(db, verifyCfg.queueBatch, { logger: console }),
      },
      {
        id: 'verify:rolling',
        cadence: verifyCfg.rollingCron,
        run: () => runRollingVerification(db, verifyCfg.rollingBatch, { logger: console }),
      },
    ];
    for (const job of verifyJobs) {
      if (!cron.validate(job.cadence)) {
        console.warn(`[ingest:watch] invalid cadence '${job.cadence}' for ${job.id} — skipping`);
        continue;
      }
      const task = cron.schedule(job.cadence, () => {
        chain.enqueue(job.id, () => {
          heartbeat.recordTick(job.id);
          return job.run();
        });
      });
      jobs.push({ sourceId: job.id, cadence: job.cadence, stop: () => void task.stop() });
      console.log(`[ingest:watch] scheduled ${job.id} @ '${job.cadence}'`);
    }
  }

  heartbeat.start();
  jobs.push({
    sourceId: 'scheduler:heartbeat',
    cadence: `interval:${60_000}ms`,
    stop: () => heartbeat.stop(),
  });

  console.log(`[ingest:watch] ${jobs.length} job(s) registered — Ctrl-C to stop`);
  return jobs;
}

/**
 * Process-level policy for the long-running scheduler entrypoints: log an
 * unhandled rejection loudly but keep the process (and every cron job) alive.
 * With enqueue-everywhere this should be unreachable from scheduled work; it
 * guards stray fire-and-forget promises in connector code. Node's default
 * (crash) turned one rejected promise into "every daily job silently dead
 * until the next restart" during the 2026-07-10 incident window.
 */
export function installSchedulerProcessGuards(proc: NodeJS.Process = process): void {
  proc.on('unhandledRejection', (reason) => {
    console.error('[ingest:watch] UNHANDLED REJECTION (scheduler continues):', reason);
  });
}

// Direct invocation: `npm run ingest:watch [-- --source=…]`
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  installSchedulerProcessGuards();
  const args = parseArgs(process.argv.slice(2));
  startScheduler(openDb(), buildConnectors(args));
}
