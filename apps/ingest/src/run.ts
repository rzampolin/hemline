/**
 * One-shot ingest — `npm run ingest [-- --source=<id|kind> --store=<domain> --watch --no-extract --no-embed]`.
 *
 *   npm run ingest                                # all: fixtures + ebay (+mock) + verified Shopify stores
 *   npm run ingest -- --source=fixtures           # one kind
 *   npm run ingest -- --source=shopify:staud.clothing
 *   npm run ingest -- --source=jsonld             # all verified JSON-LD stores
 *   npm run ingest -- --source=jsonld:thereformation.com
 *   npm run ingest -- --store=staud.clothing      # shorthand (JSON-LD stores win on domain clash)
 *   npm run ingest -- --watch                     # long-running node-cron scheduler
 *
 * Per-source error isolation: one bad store never kills the run.
 */
import { runPipeline, type PipelineResult } from './pipeline';
import { installSchedulerProcessGuards, startScheduler } from './schedule';
import { buildConnectors, openDb, parseArgs, shouldRunConnector } from './sources';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const connectors = buildConnectors(args);

  if (args.watch) {
    installSchedulerProcessGuards();
    startScheduler(db, connectors);
    return; // node-cron keeps the process alive
  }

  console.log(`[ingest] one-shot run: ${connectors.length} source(s)`);
  const results: { id: string; result?: PipelineResult; error?: string }[] = [];

  for (const connector of connectors) {
    try {
      // gate INSIDE the try — a throwing gate (e.g. SQLITE_BUSY) is this
      // source's failure, never the whole run's (same class as the 2026-07-10
      // scheduler poison, docs/decisions-scheduler.md #1)
      const gate = shouldRunConnector(db, connector);
      if (!gate.run) {
        console.log(`[ingest:${connector.id}] ${gate.reason} — skipping`);
        continue;
      }
      const result = await runPipeline(db, connector, { extract: args.extract, embed: args.embed });
      results.push({ id: connector.id, result });
    } catch (e) {
      // runPipeline isolates internally; this is the belt to its braces
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[ingest:${connector.id}] FAILED: ${error}`);
      results.push({ id: connector.id, error });
    }
  }

  console.log('\n[ingest] summary');
  for (const r of results) {
    if (r.result) {
      const s = r.result.stats;
      console.log(
        `  ${r.result.status === 'ok' ? 'ok   ' : 'error'} ${r.id}${s.mock ? ' [MOCK]' : ''} — fetched=${s.fetched} new=${s.new} updated=${s.updated} unchanged=${s.unchanged} removed=${s.removed} pruned=${s.pruned} errors=${s.errors}`,
      );
    } else {
      console.log(`  error ${r.id} — ${r.error}`);
    }
  }

  const anyOk = results.some((r) => r.result?.status === 'ok');
  process.exitCode = results.length === 0 || anyOk ? 0 : 1;
}

main().catch((e) => {
  console.error('[ingest] fatal:', e);
  process.exitCode = 1;
});
