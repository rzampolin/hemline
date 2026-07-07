/**
 * Long-running scheduler — `npm run ingest:watch` (or `npm run ingest -- --watch`).
 * Registers one node-cron job per source: cadence comes from the sources row
 * when present (admin-editable, product spec G3) else the connector default
 * (Shopify daily, eBay 6-hourly — docs/ARCHITECTURE.md §8).
 */
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import type { SourceConnector } from '@hemline/contracts';
import type { Db } from '@hemline/db';
import { runPipeline } from './pipeline';
import { buildConnectors, cadenceFor, isSourceEnabled, openDb, parseArgs } from './sources';

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

  console.log(`[ingest:watch] ${jobs.length} job(s) registered — Ctrl-C to stop`);
  return jobs;
}

// Direct invocation: `npm run ingest:watch [-- --source=…]`
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  startScheduler(openDb(), buildConnectors(args));
}
