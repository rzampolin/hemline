/**
 * Programmatic entrypoint for the ingest pipeline (integration 2026-07-06).
 *
 * `POST /api/admin/ingest` (apps/web) imports this instead of recording a
 * `not_implemented` stub run. Deliberately does NOT import schedule.ts, so
 * node-cron stays out of the web bundle; the CLI (`npm run ingest`) and the
 * scheduler keep using run.ts / schedule.ts directly.
 */
import type { Logger } from '@hemline/contracts';
import type { Db } from '@hemline/db';
import { consoleLogger, runPipeline, type PipelineResult, type PipelineStats } from './pipeline';
import { buildConnectors, isSourceEnabled } from './sources';

export { runPipeline, consoleLogger } from './pipeline';
export type { PipelineResult, PipelineStats } from './pipeline';
export { buildConnectors, isSourceEnabled, openDb } from './sources';

export interface IngestRunOutcome {
  /** per-connector results (one connector can serve several sub-source ids) */
  results: { connectorId: string; result?: PipelineResult; error?: string }[];
  status: 'ok' | 'error';
  /** aggregated across connectors, for the trigger's ingest_runs row */
  stats: PipelineStats;
}

/**
 * Resolve a `sources.id`-style identifier to connector selection input.
 * The fixtures connector registers sub-sources `fixture:shopify` /
 * `fixture:ebay` (DECISIONS.md #3) — both map back to the `fixtures`
 * connector.
 */
function normalizeSourceId(sourceId?: string): string | undefined {
  if (!sourceId) return undefined;
  if (sourceId === 'fixtures' || sourceId.startsWith('fixture:')) return 'fixtures';
  return sourceId; // 'ebay' | 'shopify' | 'shopify:<domain>'
}

/**
 * One-shot ingest for a source id (or all enabled connectors when omitted).
 * Per-connector error isolation mirrors run.ts; never throws for a
 * connector-level failure — the outcome carries it.
 */
export async function runIngestForSource(
  db: Db,
  sourceId?: string,
  opts: { logger?: Logger; extract?: boolean } = {},
): Promise<IngestRunOutcome> {
  const logger = opts.logger ?? consoleLogger;
  const connectors = buildConnectors({ source: normalizeSourceId(sourceId) });

  const results: IngestRunOutcome['results'] = [];
  for (const connector of connectors) {
    if (!isSourceEnabled(db, connector.id)) {
      logger.info(`[ingest:${connector.id}] disabled in sources table — skipping`);
      continue;
    }
    try {
      const result = await runPipeline(db, connector, { logger, extract: opts.extract });
      results.push({ connectorId: connector.id, result });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`[ingest:${connector.id}] FAILED: ${error}`);
      results.push({ connectorId: connector.id, error });
    }
  }

  const stats: PipelineStats = {
    fetched: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    removed: 0,
    pruned: 0,
    extracted: 0,
    extractionPending: 0,
    mock: false,
  };
  for (const r of results) {
    if (!r.result) {
      stats.errors += 1;
      continue;
    }
    const s = r.result.stats;
    stats.fetched += s.fetched;
    stats.new += s.new;
    stats.updated += s.updated;
    stats.unchanged += s.unchanged;
    stats.errors += s.errors;
    stats.removed += s.removed;
    stats.pruned += s.pruned;
    stats.extracted += s.extracted;
    stats.extractionPending += s.extractionPending;
    stats.mock = stats.mock || s.mock;
  }
  const anyOk = results.some((r) => r.result?.status === 'ok');
  return { results, status: results.length > 0 && anyOk ? 'ok' : 'error', stats };
}
