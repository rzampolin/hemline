/**
 * Manual sold-detection verification run — `npm run verify:listings`.
 *
 *   npm run verify:listings                        # drain clickout queue + one rolling batch
 *   npm run verify:listings -- --listing=<id>      # verify exactly one listing
 *   npm run verify:listings -- --rolling=200       # override the rolling batch size
 *   npm run verify:listings -- --queue-only        # drain the clickout queue, skip the sweep
 *
 * Pure HTTP through the politeness stack (HemlineBot UA, ≥1s/host, one
 * 429/5xx retry) — no AI cost. Prod (Dockerfile bundle):
 *   fly ssh console -C "node /app/dist/verify-listings.mjs"
 */
import { ensureSchema } from '@hemline/db';
import { openDb } from './sources';
import {
  drainVerificationQueue,
  runRollingVerification,
  summarize,
  verifyEnvConfig,
  verifyListings,
  type VerifyResult,
} from './verification';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

  const db = openDb();
  ensureSchema(db); // additive column/table — idempotent
  const cfg = verifyEnvConfig();
  const logger = { info: console.log, warn: console.warn, error: console.error };

  const listingId = get('listing');
  if (listingId) {
    const results = await verifyListings(db, [listingId], { logger });
    report('listing', results);
    return;
  }

  const queued = await drainVerificationQueue(db, cfg.queueBatch, { logger });
  report('clicked queue', queued);

  if (!argv.includes('--queue-only')) {
    const rollingLimit = Number(get('rolling') ?? cfg.rollingBatch);
    const rolling = await runRollingVerification(db, rollingLimit, { logger });
    report('rolling sweep', rolling);
  }
}

function report(label: string, results: VerifyResult[]): void {
  console.log(`[verify] ${label}: ${summarize(results)}`);
  for (const r of results) {
    if (r.outcome === 'gone' || r.outcome === 'sold_out' || r.outcome === 'availability_updated') {
      console.log(`[verify]   ${r.listingId} → ${r.outcome}${r.note ? ` (${r.note})` : ''}`);
    }
  }
}

main().catch((e) => {
  console.error('[verify] fatal:', e);
  process.exitCode = 1;
});
