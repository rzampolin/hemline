/**
 * Upgrade pass — re-extract mock-extracted listings with the live model.
 *
 * Keyless dev runs leave `model='mock'` rows in `extractions`; the normal
 * queue (buildPendingExtractionInputs) treats those listings as done, so
 * adding ANTHROPIC_API_KEY alone never upgrades them. This script clears the
 * mock rows (manual corrections and fixture ground truth are never touched)
 * and drains the queue with the live service.
 *
 *   npm run extract:upgrade
 *
 * Safe to re-run: already-live rows are skipped, and an interrupted or
 * budget-capped run resumes where it left off.
 *
 * Cost reporting (2026-07-07): prints an UPFRONT estimate before starting and
 * the ACTUAL metered total at completion, plus per-batch running cost and the
 * service's validation-recovery counters (retries / coercions / fallbacks).
 */
import { isNull } from 'drizzle-orm';
import type { Logger } from '@hemline/contracts';
import { listings } from '@hemline/db';
import {
  buildPendingExtractionInputs,
  deleteMockExtractions,
  runExtraction,
  type ExtractionOutcome,
} from './extraction';
import { openDb } from './sources';

/**
 * Upfront per-listing estimate (live Haiku 4.5, $1/MTok in, $5/MTok out):
 * ~1,200 prompt tokens (cached system block bills ~0.1x after the first call,
 * assume ~400 effective) + ~300 output tokens; ~1/3 of listings attach the
 * primary image (+~1,600 image tokens) under the two-pass heuristic.
 * ≈ (400 + 533 image-avg) in + 300 out → ~$0.0025/listing. We quote $0.003 to
 * stay conservative.
 */
const EST_COST_PER_LISTING_USD = 0.003;
const EST_ASSUMPTIONS =
  '~1.2k prompt tok (system block prompt-cached ~0.1x) + ~300 output tok per listing, ' +
  '+~1.6k image tok on the ~1/3 of listings that attach the primary photo; Haiku 4.5 at $1/$5 per MTok';

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '[upgrade] ANTHROPIC_API_KEY is not set — add it to .env first. Aborting (nothing changed).',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const sourceIds = [
    ...new Set(
      db
        .select({ id: listings.sourceId })
        .from(listings)
        .where(isNull(listings.removedAt))
        .all()
        .map((r) => r.id),
    ),
  ];
  const deleted = deleteMockExtractions(db, sourceIds);
  console.log(
    `[upgrade] cleared ${deleted} mock extraction row(s) across ${sourceIds.length} source(s)`,
  );

  // ── upfront estimate ────────────────────────────────────────────────────
  const initialQueue = buildPendingExtractionInputs(db, sourceIds).length;
  console.log(
    `[upgrade] UPFRONT ESTIMATE: ~${initialQueue} listing(s) × ~${usd(EST_COST_PER_LISTING_USD)}/listing ≈ ${usd(initialQueue * EST_COST_PER_LISTING_USD)}`,
  );
  console.log(`[upgrade]   assumptions: ${EST_ASSUMPTIONS}`);
  console.log(
    `[upgrade]   AI_DAILY_BUDGET_USD=${process.env.AI_DAILY_BUDGET_USD ?? '5 (default)'} — the run stops cleanly at the cap and resumes on re-run`,
  );

  const logger: Logger = { info: console.log, warn: console.warn, error: console.error };
  let extracted = 0;
  let totalCostUsd = 0;
  const totals = {
    liveCalls: 0,
    retries: 0,
    retrySuccesses: 0,
    coercions: 0,
    imageUrlFailures: 0,
    fallbacks: 0,
    mockExtractions: 0,
  };

  function fold(outcome: ExtractionOutcome): void {
    extracted += outcome.extracted;
    totalCostUsd += outcome.costUsd ?? 0;
    if (outcome.stats) {
      totals.liveCalls += outcome.stats.liveCalls;
      totals.retries += outcome.stats.retries;
      totals.retrySuccesses += outcome.stats.retrySuccesses;
      totals.coercions += outcome.stats.coercions;
      totals.imageUrlFailures += outcome.stats.imageUrlFailures ?? 0;
      totals.fallbacks += outcome.stats.fallbacks;
      totals.mockExtractions += outcome.stats.mockExtractions;
    }
  }

  for (;;) {
    const inputs = buildPendingExtractionInputs(db, sourceIds);
    if (inputs.length === 0) break;
    const outcome = await runExtraction(db, inputs, logger);
    fold(outcome);
    if (outcome.extracted === 0) {
      console.error(
        `[upgrade] no progress — ${outcome.pending} listing(s) still pending (service failure or AI_DAILY_BUDGET_USD cap).\n` +
          `[upgrade] spent so far: ${usd(totalCostUsd)}. To resume: re-run \`npm run extract:upgrade\` ` +
          `(tomorrow, or after raising AI_DAILY_BUDGET_USD in .env).`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `[upgrade] progress: ${extracted} extracted, running cost ${usd(totalCostUsd)} ` +
        `(retries ${totals.retries}, coercions ${totals.coercions}, ` +
        `image-URL failures ${totals.imageUrlFailures}, fallbacks ${totals.fallbacks}), queue refilling…`,
    );
  }

  console.log(`[upgrade] done — ${extracted} listing(s) re-extracted with the live model`);
  console.log(
    `[upgrade] ACTUAL COST: ${usd(totalCostUsd)} across ${totals.liveCalls} live call(s) ` +
      `(estimate was ${usd(initialQueue * EST_COST_PER_LISTING_USD)} for ${initialQueue})`,
  );
  console.log(
    `[upgrade] validation recovery: ${totals.retries} retried (${totals.retrySuccesses} fixed by retry), ` +
      `${totals.coercions} coerced, ${totals.imageUrlFailures} image-URL failure(s) retried TEXT-ONLY (stayed live), ` +
      `${totals.fallbacks} fell back to mock, ${totals.mockExtractions} total mock extraction(s)`,
  );
}

void main();
