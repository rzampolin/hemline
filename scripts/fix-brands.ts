/**
 * Production brand-fix entrypoint — bundled by the Dockerfile into
 * /app/dist/fix-brands.mjs (same pattern as prod-seed → dist/seed.mjs) so it
 * runs inside the deployed container without tsx or devDependencies:
 *
 *   fly ssh console -C "node /app/dist/fix-brands.mjs"          # dry run (default)
 *   fly ssh console -C "node /app/dist/fix-brands.mjs --apply"  # commit
 *
 * Locally: npm run fix:brands [-- --apply]
 *
 * Dry-run prints the exact per-store before→after brand rewrites; --apply
 * commits them in one transaction. Idempotent — a second run reports 0
 * changes. See apps/ingest/src/fix-brands.ts for why this never touches
 * content_hash / extractions / listing_embeddings.
 */
import { createDb, resolveDbPath } from '@hemline/db';
import { fixBrands, formatBrandFixReport } from '../apps/ingest/src/fix-brands';

const apply = process.argv.includes('--apply');
const dbPath = resolveDbPath();
console.log(`[fix-brands] target db: ${dbPath}`);
const report = fixBrands(createDb({ dbPath }), { apply });
console.log(formatBrandFixReport(report));
// Delta-based gate: pre-existing orphans are normal cache remnants (listing
// content changed → new hash → old extraction row lingers). Fail only if THIS
// run grew the orphan count — the in-transaction check already rolls back in
// that case, so this is belt-and-braces reporting.
const i = report.integrity;
if (
  i.orphanedExtractions > i.orphanedExtractionsBefore ||
  i.orphanedEmbeddings > i.orphanedEmbeddingsBefore
) {
  console.error('[fix-brands] this run would grow the orphan count — investigate before applying');
  process.exitCode = 1;
}
