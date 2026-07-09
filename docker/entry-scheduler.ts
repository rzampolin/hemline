/**
 * Bundle entry for the in-container ingest scheduler (esbuild → dist/impl/,
 * launched via the dist/ingest-scheduler.mjs one-line launcher — see the
 * Dockerfile; the launcher indirection keeps `import.meta.url !== argv[1]` so
 * the repo's isMain guards stay false inside the bundle).
 *
 * Explicitly invokes what `npm run ingest:watch` does: one node-cron job per
 * enabled source (INGEST_ENABLE_* flags are honored inside the connectors'
 * isConfigured; AI_DAILY_BUDGET_USD is enforced by the packages/ai cost meter;
 * embed-on-ingest skips itself when the ML sidecar is absent).
 */
import { startScheduler } from '../apps/ingest/src/schedule';
import { buildConnectors, openDb, parseArgs } from '../apps/ingest/src/sources';

const args = parseArgs(process.argv.slice(2));
startScheduler(openDb(), buildConnectors(args));
