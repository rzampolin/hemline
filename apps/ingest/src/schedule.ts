/**
 * Long-running scheduler — `npm run ingest:watch` (or `npm run ingest -- --watch`).
 * Registers one node-cron job per source: cadence comes from the sources row
 * when present (admin-editable, product spec G3) else the connector default
 * (Shopify daily, eBay 6-hourly — docs/ARCHITECTURE.md §8).
 *
 * Also registers the sold-detection verification jobs (VERIFY_ENABLE, default
 * on): a ~15-min drain of the clickout verification queue and an hourly
 * rolling sweep of the oldest-verified active listings (verification.ts).
 */
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import type { SourceConnector } from '@hemline/contracts';
import { ensureSchema, type Db } from '@hemline/db';
import { runPipeline } from './pipeline';
import { buildConnectors, cadenceFor, isSourceEnabled, openDb, parseArgs } from './sources';
import { drainVerificationQueue, runRollingVerification, verifyEnvConfig } from './verification';

export interface ScheduledJob {
  sourceId: string;
  cadence: string;
  stop: () => void;
}

export function startScheduler(db: Db, connectors: SourceConnector[]): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  /** serialize runs so overlapping ticks (and politeness) stay sane */
  let chain: Promise<unknown> = Promise.resolve();

  for (const connector of connectors) {
    const cadence = cadenceFor(db, connector);
    if (!cron.validate(cadence)) {
      console.warn(`[ingest:watch] invalid cadence '${cadence}' for ${connector.id} — skipping`);
      continue;
    }
    const task = cron.schedule(cadence, () => {
      chain = chain.then(async () => {
        if (!isSourceEnabled(db, connector.id)) {
          console.log(`[ingest:watch] ${connector.id} disabled — tick skipped`);
          return;
        }
        try {
          await runPipeline(db, connector);
        } catch (e) {
          console.error(`[ingest:watch] ${connector.id} failed:`, e);
        }
      });
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
        chain = chain.then(async () => {
          try {
            await job.run();
          } catch (e) {
            console.error(`[ingest:watch] ${job.id} failed:`, e);
          }
        });
      });
      jobs.push({ sourceId: job.id, cadence: job.cadence, stop: () => void task.stop() });
      console.log(`[ingest:watch] scheduled ${job.id} @ '${job.cadence}'`);
    }
  }

  console.log(`[ingest:watch] ${jobs.length} job(s) registered — Ctrl-C to stop`);
  return jobs;
}

// Direct invocation: `npm run ingest:watch [-- --source=…]`
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  startScheduler(openDb(), buildConnectors(args));
}
