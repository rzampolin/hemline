/**
 * Vision length-estimation pass — `npm run extract:lengths`.
 *
 * Fills the "Measured inches" gap: extraction rows with length_inches IS NULL
 * and a primary image get ONE Haiku vision call each (grounded ~5'9" model
 * anchor, JSON-schema-constrained, sanity-clamped against the §5 length-class
 * prior bands). Results are written in place with
 * length_basis='image_estimate' so matching/UI treat them as estimates
 * (hem confidence 'medium'), never as "Measured".
 *
 * Idempotent/resumable: attempted rows are marked and skipped on re-run;
 * failed calls stay queued. Budget-capped runs stop cleanly with resume
 * instructions. Prints an UPFRONT cost estimate and the ACTUAL metered total.
 */
import { createAiClient, createLengthEstimator } from '@hemline/ai';
import type { Logger } from '@hemline/contracts';
import {
  buildLengthEstimateTargets,
  lengthCoverage,
  runLengthEstimation,
} from './length-estimation';
import { openDb } from './sources';

/**
 * Upfront per-call estimate (live Haiku 4.5, $1/MTok in, $5/MTok out):
 * one product photo ≈ 1,100–1,600 image tokens (Haiku caps images ≈1.15 MP →
 * ≤~1,600 tok; assume ~1,400 avg) + ~350 prompt tokens (system block
 * prompt-cached ~0.1x after the first call) + ~100 output tokens
 * → ≈ $0.0022/call; quoted at $0.0026 to stay conservative.
 */
const EST_COST_PER_CALL_USD = 0.0026;
const EST_ASSUMPTIONS =
  '~1.4k image tok + ~350 prompt tok (system prompt-cached) in, ~100 tok out per call; ' +
  'Haiku 4.5 at $1/$5 per MTok';

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '[lengths] ANTHROPIC_API_KEY is not set — add it to .env first. Aborting (nothing changed).',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const targets = buildLengthEstimateTargets(db);
  if (targets.length === 0) {
    console.log('[lengths] nothing to do — every eligible row already has an estimate attempt.');
    printCoverage();
    return;
  }

  // ── upfront estimate ────────────────────────────────────────────────────
  console.log(
    `[lengths] UPFRONT ESTIMATE: ${targets.length} vision call(s) × ~${usd(EST_COST_PER_CALL_USD)}/call ≈ ${usd(targets.length * EST_COST_PER_CALL_USD)}`,
  );
  console.log(`[lengths]   assumptions: ${EST_ASSUMPTIONS}`);
  console.log(
    `[lengths]   AI_DAILY_BUDGET_USD=${process.env.AI_DAILY_BUDGET_USD ?? '5 (default)'} — the run stops cleanly at the cap; re-run \`npm run extract:lengths\` to resume`,
  );

  const client = createAiClient();
  const estimator = createLengthEstimator({ client });
  const logger: Logger = { info: console.log, warn: console.warn, error: console.error };

  const startedAt = Date.now();
  const result = await runLengthEstimation(db, targets, estimator, logger, {
    concurrency: 5,
    shouldStop: () => client.effectiveMode() === 'mock',
    onProgress: (processed) => {
      if (processed % 50 === 0 || processed === targets.length) {
        console.log(
          `[lengths] progress: ${processed}/${targets.length} — running cost ${usd(estimator.costUsd())} ` +
            `(${estimator.stats.estimated} estimated, ${estimator.stats.clamped} clamped, ` +
            `${estimator.stats.noEstimate} no-estimate, ${estimator.stats.failed} failed)`,
        );
      }
    },
  });

  const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  if (result.stopped) {
    const reason = client.effectiveMode() === 'mock' ? 'AI_DAILY_BUDGET_USD cap reached' : 'repeated call failures';
    console.error(
      `[lengths] STOPPED (${reason}) after ${result.attempted}/${targets.length} row(s), spent ${usd(estimator.costUsd())}.\n` +
        `[lengths] Attempted rows are saved; to resume the remainder re-run \`npm run extract:lengths\` ` +
        `(tomorrow, or after raising AI_DAILY_BUDGET_USD in .env).`,
    );
    process.exitCode = 1;
  } else {
    console.log(`[lengths] done in ${elapsedMin} min — ${result.attempted} row(s) processed`);
  }

  console.log(
    `[lengths] outcomes: ${result.estimated} estimated, ${result.clamped} clamped to class prior, ` +
      `${result.noEstimate} not estimable, ${result.failed} failed (still queued)`,
  );
  console.log(
    `[lengths] ACTUAL COST: ${usd(estimator.costUsd())} across ${estimator.stats.calls} vision call(s) ` +
      `(estimate was ${usd(targets.length * EST_COST_PER_CALL_USD)} for ${targets.length})`,
  );
  printCoverage();

  function printCoverage(): void {
    const c = lengthCoverage(db);
    const pct = (n: number) => ((100 * n) / Math.max(1, c.liveListings)).toFixed(1);
    console.log(
      `[lengths] coverage (live listings ${c.liveListings}): length_inches ${c.withInches} (${pct(c.withInches)}%) ` +
        `= ${c.stated} stated (${pct(c.stated)}%) + ${c.imageEstimated} image-estimated (${pct(c.imageEstimated)}%); ` +
        `length_class ${c.withClass} (${pct(c.withClass)}%)`,
    );
  }
}

void main();
