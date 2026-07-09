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
if (report.integrity.orphanedExtractions !== 0 || report.integrity.orphanedEmbeddings !== 0) {
  console.error('[fix-brands] pre-existing orphaned extraction/embedding rows detected (not caused by this run)');
  process.exitCode = 1;
}
