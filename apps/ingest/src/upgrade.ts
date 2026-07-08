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
 */
import { isNull } from 'drizzle-orm';
import type { Logger } from '@hemline/contracts';
import { listings } from '@hemline/db';
import { buildPendingExtractionInputs, deleteMockExtractions, runExtraction } from './extraction';
import { openDb } from './sources';

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

  const logger: Logger = { info: console.log, warn: console.warn, error: console.error };
  let extracted = 0;
  for (;;) {
    const inputs = buildPendingExtractionInputs(db, sourceIds);
    if (inputs.length === 0) break;
    const outcome = await runExtraction(db, inputs, logger);
    extracted += outcome.extracted;
    if (outcome.extracted === 0) {
      console.error(
        `[upgrade] no progress — ${outcome.pending} listing(s) still pending (service failure or AI_DAILY_BUDGET_USD cap). Re-run later to resume.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[upgrade] progress: ${extracted} extracted, queue refilling…`);
  }
  console.log(`[upgrade] done — ${extracted} listing(s) re-extracted with the live model`);
}

void main();
