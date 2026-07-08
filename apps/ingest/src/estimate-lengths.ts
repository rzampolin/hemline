/**
 * Vision length-estimation pass — `npm run extract:lengths`.
 *
 * Fills the "Measured inches" gap: extraction rows with length_inches IS NULL
 * and a primary image get ONE Haiku vision call each, JSON-schema-constrained
 * and sanity-clamped against the §5 length-class prior bands. Results are
 * written in place with length_basis='image_estimate' so matching/UI treat
 * them as estimates (hem confidence 'medium'), never as "Measured".
 *
 * v2 anchoring: the free deterministic parser extracts the STATED model
 * height from listing text ("Model is 5'10" and wears a size S") — when
 * present, the prompt anchors on THAT height with proportionally scaled body
 * landmarks instead of the assumed 5'9"; the anchor used is recorded per row.
 * Parser coverage is reported BEFORE any cost is quoted or spent.
 *
 *   npm run extract:lengths              # fresh pass (un-attempted rows)
 *   npm run extract:lengths -- --reanchor
 *     # re-run default-anchored estimates whose listing states a model height
 *     # ≥1" off the 69" assumption, with the correct anchor
 *
 * Idempotent/resumable: attempted rows are marked ('image_estimate' with
 * inches, or 'not_estimable' without) and skipped on re-run; reanchored rows
 * get length_anchor='stated_model_height' and are never re-selected; failed
 * calls stay queued. Budget-capped runs stop cleanly with resume
 * instructions. Prints an UPFRONT cost estimate and the ACTUAL metered total.
 */
import { createAiClient, createLengthEstimator } from '@hemline/ai';
import type { Logger } from '@hemline/contracts';
import {
  buildLengthEstimateTargets,
  buildReanchorTargets,
  lengthCoverage,
  migrateLengthBookkeeping,
  runLengthEstimation,
  REANCHOR_MIN_DELTA_IN,
  type LengthEstimateTarget,
} from './length-estimation';
import { openDb } from './sources';

/**
 * Upfront per-call estimate (live Haiku 4.5, $1/MTok in, $5/MTok out):
 * one product photo ≈ 1,100–1,600 image tokens (Haiku caps images ≈1.15 MP →
 * ≤~1,600 tok; assume ~1,400 avg) + ~350 prompt tokens (system block
 * prompt-cached ~0.1x after the first call; the stated-height anchor adds
 * ~60 uncached tok) + ~100 output tokens
 * → ≈ $0.0022/call; quoted at $0.0026 to stay conservative.
 */
const EST_COST_PER_CALL_USD = 0.0026;
const EST_ASSUMPTIONS =
  '~1.4k image tok + ~350-410 prompt tok (system prompt-cached) in, ~100 tok out per call; ' +
  'Haiku 4.5 at $1/$5 per MTok';

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  const reanchor = process.argv.includes('--reanchor');
  const label = reanchor ? 'lengths --reanchor' : 'lengths';
  const db = openDb();

  // ── free, deterministic phase: bookkeeping + parser coverage ────────────
  const migrated = migrateLengthBookkeeping(db);
  if (migrated > 0) {
    console.log(
      `[${label}] bookkeeping: ${migrated} clamped/not-estimable row(s) re-marked ` +
        `length_basis='not_estimable' (was 'image_estimate' with NULL inches; no API calls)`,
    );
  }

  let targets: LengthEstimateTarget[];
  if (reanchor) {
    const scan = buildReanchorTargets(db);
    console.log(
      `[${label}] REANCHOR SCAN (free, deterministic parser): ${scan.scanned} default-anchored ` +
        `image-estimate row(s) scanned; ${scan.withStatedHeight} listing(s) state the model's height; ` +
        `${scan.targets.length} differ from the assumed 69" by ≥${REANCHOR_MIN_DELTA_IN}" → re-estimation targets`,
    );
    targets = scan.targets;
  } else {
    targets = buildLengthEstimateTargets(db);
    const withStated = targets.filter((t) => t.statedModelHeightInches != null).length;
    console.log(
      `[${label}] parser coverage (free, deterministic): ${withStated}/${targets.length} target(s) ` +
        `state the model's height → anchored prompts; the rest use the 5'9" default anchor`,
    );
  }

  if (targets.length === 0) {
    console.log(`[${label}] nothing to do — no eligible rows. No API cost incurred.`);
    printCoverage();
    return;
  }

  // ── upfront estimate (before any spend) ─────────────────────────────────
  console.log(
    `[${label}] UPFRONT ESTIMATE: ${targets.length} vision call(s) × ~${usd(EST_COST_PER_CALL_USD)}/call ≈ ${usd(targets.length * EST_COST_PER_CALL_USD)}`,
  );
  console.log(`[${label}]   assumptions: ${EST_ASSUMPTIONS}`);
  console.log(
    `[${label}]   AI_DAILY_BUDGET_USD=${process.env.AI_DAILY_BUDGET_USD ?? '5 (default)'} — the run stops cleanly at the cap; re-run \`${resumeCommand()}\` to resume`,
  );

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      `[${label}] ANTHROPIC_API_KEY is not set — add it to .env first. ` +
        'Aborting before any API spend (coverage report above is complete and free).',
    );
    process.exitCode = 1;
    return;
  }

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
          `[${label}] progress: ${processed}/${targets.length} — running cost ${usd(estimator.costUsd())} ` +
            `(${estimator.stats.estimated} estimated, ${estimator.stats.clamped} clamped, ` +
            `${estimator.stats.noEstimate} no-estimate, ${estimator.stats.failed} failed)`,
        );
      }
    },
  });

  const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  if (result.stopped) {
    const reason =
      client.effectiveMode() === 'mock' ? 'AI_DAILY_BUDGET_USD cap reached' : 'repeated call failures';
    console.error(
      `[${label}] STOPPED (${reason}) after ${result.attempted}/${targets.length} row(s), spent ${usd(estimator.costUsd())}.\n` +
        `[${label}] Attempted rows are saved; to resume the remainder re-run \`${resumeCommand()}\` ` +
        `(tomorrow, or after raising AI_DAILY_BUDGET_USD in .env).`,
    );
    process.exitCode = 1;
  } else {
    console.log(`[${label}] done in ${elapsedMin} min — ${result.attempted} row(s) processed`);
  }

  console.log(
    `[${label}] outcomes: ${result.estimated} estimated, ${result.clamped} clamped to class prior, ` +
      `${result.noEstimate} not estimable, ${result.failed} failed (still queued)`,
  );
  console.log(
    `[${label}] ACTUAL COST: ${usd(estimator.costUsd())} across ${estimator.stats.calls} vision call(s) ` +
      `(estimate was ${usd(targets.length * EST_COST_PER_CALL_USD)} for ${targets.length})`,
  );
  printCoverage();

  function resumeCommand(): string {
    return reanchor ? 'npm run extract:lengths -- --reanchor' : 'npm run extract:lengths';
  }

  function printCoverage(): void {
    const c = lengthCoverage(db);
    const pct = (n: number) => ((100 * n) / Math.max(1, c.liveListings)).toFixed(1);
    console.log(
      `[${label}] coverage (live listings ${c.liveListings}): length_inches ${c.withInches} (${pct(c.withInches)}%) ` +
        `= ${c.stated} stated (${pct(c.stated)}%) + ${c.imageEstimated} image-estimated (${pct(c.imageEstimated)}%, ` +
        `of which ${c.anchoredStatedHeight} anchored on a stated model height); ` +
        `${c.notEstimable} not-estimable; length_class ${c.withClass} (${pct(c.withClass)}%)`,
    );
  }
}

void main();
