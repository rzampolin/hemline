/**
 * Production kids-listing purge entrypoint — bundled by the Dockerfile into
 * /app/dist/purge-kids.mjs (same pattern as fix-brands → dist/fix-brands.mjs)
 * so it runs inside the deployed container without tsx or devDependencies:
 *
 *   fly ssh console -C "node /app/dist/purge-kids.mjs"           # dry run (default, free)
 *   fly ssh console -C "node /app/dist/purge-kids.mjs --apply"   # soft-delete flagged rows
 *   fly ssh console -C "node /app/dist/purge-kids.mjs --recheck-vision"
 *     # + Haiku image verdicts for the ambiguous survivors (Dôen case):
 *     # suspects = active listings from known-kids-line stores without an
 *     # extraction audience. Cost-quoted upfront ($0.0006/call — real
 *     # calibration $5.81/9,981) and budget-guarded (--budget-usd, default 1).
 *     # Verdicts persist to extractions.audience even in dry-run (paid answers
 *     # are kept); child listings are soft-deleted only with --apply.
 *   fly ssh console -C "node /app/dist/purge-kids.mjs --recheck-vision --apply --budget-usd=2"
 *
 * Locally: npm run purge:kids [-- --apply --recheck-vision --budget-usd=1]
 *   --kids-line-sources=shopify:a.com,shopify:b.com   # override the suspect pool
 *
 * Soft-delete = removed_at = now (verifier semantics: feed/search exclude
 * removed rows; saves keep them for the "possibly sold" rack UX). Idempotent —
 * a second --apply run flags 0 rows.
 */
import { createAudienceChecker } from '@hemline/ai';
import { createDb, ensureSchema, resolveDbPath } from '@hemline/db';
import {
  findVisionSuspects,
  formatPurgeReport,
  KNOWN_KIDS_LINE_SOURCE_IDS,
  purgeKids,
  recheckVision,
  VISION_COST_PER_CALL_USD,
} from '../apps/ingest/src/purge-kids';

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const apply = argv.includes('--apply');
  const vision = argv.includes('--recheck-vision');
  const budgetUsd = Number(get('budget-usd') ?? '1');
  const kidsLineSources = get('kids-line-sources')?.split(',').map((s) => s.trim()) ?? [
    ...KNOWN_KIDS_LINE_SOURCE_IDS,
  ];

  const dbPath = resolveDbPath();
  console.log(`[purge-kids] target db: ${dbPath}`);
  const db = createDb({ dbPath });
  ensureSchema(db); // additive extractions.audience column — idempotent

  // ── pass 1: free heuristic scan (title keywords + kid-size majority) ─────
  const report = purgeKids(db, { apply });
  console.log(formatPurgeReport(report));

  if (!vision) {
    const suspects = findVisionSuspects(db, kidsLineSources);
    if (suspects.length > 0) {
      console.log(
        `[purge-kids] ${suspects.length} ambiguous suspect(s) from known-kids-line stores ` +
          `(${kidsLineSources.join(', ')}) lack an audience verdict — re-run with --recheck-vision ` +
          `(estimated ${usd(suspects.length * VISION_COST_PER_CALL_USD)})`,
      );
    }
    return;
  }

  // ── pass 2: bounded vision recheck over the suspects only ────────────────
  const suspects = findVisionSuspects(db, kidsLineSources);
  const estimate = suspects.length * VISION_COST_PER_CALL_USD;
  console.log(
    `[purge-kids] vision recheck: ${suspects.length} suspect(s) from [${kidsLineSources.join(', ')}] ` +
      `× ~${usd(VISION_COST_PER_CALL_USD)}/call (real calibration: $5.81/9,981 calls) ≈ ${usd(estimate)}; ` +
      `budget ${usd(budgetUsd)}${estimate > budgetUsd ? ` — capped at ${Math.floor(budgetUsd / VISION_COST_PER_CALL_USD)} call(s), re-run to resume` : ''}`,
  );
  if (suspects.length === 0) {
    console.log('[purge-kids] no suspects — no API cost incurred.');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '[purge-kids] ANTHROPIC_API_KEY is not set — aborting before any API spend ' +
        '(the heuristic report above is complete and free).',
    );
    process.exitCode = 1;
    return;
  }

  const checker = createAudienceChecker();
  const result = await recheckVision(db, suspects, checker, { apply, budgetUsd });
  console.log(
    `[purge-kids] vision: ${result.checked} classified (${result.child} child, ${result.adult} adult, ` +
      `${result.undecided} undecided), ${result.imageUnavailable} image-unavailable, ${result.failed} failed, ` +
      `${result.skippedForBudget} skipped for budget — ACTUAL COST ${usd(result.costUsd)}`,
  );
  for (const t of result.childTitles) console.log(`[purge-kids]   CHILD: ${t}`);
  if (result.child > 0 && !apply) {
    console.log(
      `[purge-kids] verdicts persisted to extractions.audience; re-run with --apply to soft-delete ` +
        `the ${result.child} child listing(s) (already excluded from candidates by the audience filter).`,
    );
  }
  if (apply && result.removed > 0) {
    console.log(`[purge-kids] soft-deleted ${result.removed} vision-confirmed child listing(s).`);
  }
}

main().catch((e) => {
  console.error('[purge-kids] fatal:', e);
  process.exitCode = 1;
});
