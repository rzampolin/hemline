/**
 * `npm run embed` — batch-embed catalog images with Marqo-FashionSigLIP
 * (2026-07-07 ml-eng).
 *
 * Idempotent by content_hash: only active listings whose CURRENT content_hash
 * has no vector under the model tag are queued (content change → new hash →
 * re-embedded; unchanged listings are skipped for free). Local compute — no
 * API cost; the report shows elapsed time + throughput instead.
 *
 * Flags: --limit=N (cap this run) · --batch-size=N (images per forward pass,
 * default 8) · --dry-run (report the queue, embed nothing)
 */
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import {
  createDb,
  ensureSchema,
  embeddingStats,
  listingsMissingEmbedding,
  upsertEmbedding,
} from '@hemline/db';
import { EmbedderProcess, resolveEmbedder } from '@hemline/matching/embedder';
// placeholder filter shared with the embed-on-ingest pipeline step
import { isPlaceholderImage } from './embedding';

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const [, value] = arg.split('=', 2);
  return value ?? 'true';
}

async function main(): Promise<void> {
  const limit = flag('limit') ? Number(flag('limit')) : undefined;
  const batchSize = flag('batch-size') ? Number(flag('batch-size')) : 8;
  const dryRun = flag('dry-run') === 'true';

  const db = createDb();
  ensureSchema(db);

  const before = embeddingStats(db, EMBEDDING_MODEL_TAG);
  const missing = listingsMissingEmbedding(db, EMBEDDING_MODEL_TAG, limit);
  const queue = missing.filter((t) => !isPlaceholderImage(t.imageUrl));
  const placeholders = missing.length - queue.length;
  console.log(
    `[embed] model=${EMBEDDING_MODEL_TAG} · ${before.count} listings already embedded · ` +
      `${queue.length} to embed${limit ? ` (limit ${limit})` : ''}` +
      (placeholders > 0 ? ` · ${placeholders} skipped (placeholder images, attribute-path only)` : ''),
  );
  if (queue.length === 0) {
    console.log('[embed] nothing to do — catalog is up to date.');
    return;
  }
  if (dryRun) {
    console.log('[embed] --dry-run: skipping. First 5 queued:');
    for (const t of queue.slice(0, 5)) console.log(`  ${t.listingId}  ${t.imageUrl}`);
    return;
  }

  const paths = resolveEmbedder();
  if (!paths) {
    console.error('[embed] ml not set up — run `npm run ml:setup` first.');
    console.error('[embed] (the app keeps working without it: attribute-vector similarity is the fallback)');
    process.exitCode = 1;
    return;
  }

  console.log(`[embed] spawning sidecar (${paths.python}) — model load takes ~10–20s…`);
  const embedder = new EmbedderProcess({ paths, batchSize, timeoutMs: 0 });
  const t0 = Date.now();
  let done = 0;
  let failed = 0;

  // Fire everything; the child batches internally, results resolve in order.
  const work = queue.map(async (task) => {
    try {
      const vector = await embedder.embed({ imageUrl: task.imageUrl });
      upsertEmbedding(db, {
        listingId: task.listingId,
        contentHash: task.contentHash,
        model: EMBEDDING_MODEL_TAG,
        vector,
        imageUrl: task.imageUrl,
      });
      done++;
    } catch (err) {
      failed++;
      console.warn(
        `[embed] ${task.listingId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const total = done + failed;
    if (total % 25 === 0 || total === queue.length) {
      const rate = done / Math.max((Date.now() - t0) / 1000, 1e-9);
      console.log(
        `[embed] ${total}/${queue.length} (${failed} failed) · ${rate.toFixed(2)} img/s`,
      );
    }
  });

  // All requests are written (embed() writes synchronously on call); close
  // stdin so the sidecar flushes the final partial batch, then await results.
  embedder.endInput();
  await Promise.all(work);
  await embedder.dispose();

  const elapsed = (Date.now() - t0) / 1000;
  const after = embeddingStats(db, EMBEDDING_MODEL_TAG);
  console.log(
    `[embed] done: ${done} embedded, ${failed} failed in ${elapsed.toFixed(1)}s ` +
      `(${(done / Math.max(elapsed, 1e-9)).toFixed(2)} img/s incl. model load) · ` +
      `catalog now has ${after.count} vectors · cost: $0 (local compute)`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[embed] fatal:', err);
  process.exitCode = 1;
});
