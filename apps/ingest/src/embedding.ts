/**
 * Embed-on-ingest (2026-07-08) — the reusable core of `npm run embed`, wired
 * into the pipeline so NEW/CHANGED listings get vectors automatically after
 * the extraction hand-off (content change → new content_hash → the listing
 * shows up in listingsMissingEmbedding again; unchanged listings cost $0).
 *
 * Fire-safe by design: when the ML sidecar isn't set up (no venv) the step
 * SKIPS with one info line — never an error; any other failure is caught by
 * the pipeline and only warns. Local compute, no API cost, same politeness/
 * caching story as `npm run embed` (images are fetched by the sidecar once
 * per content hash).
 */
import { EMBEDDING_MODEL_TAG, type Logger } from '@hemline/contracts';
import { listingsMissingEmbedding, upsertEmbedding, type Db } from '@hemline/db';
import {
  EmbedderProcess,
  resolveEmbedder,
  type EmbedderPaths,
} from '@hemline/matching/embedder';

/**
 * Placeholder-image hosts are excluded from visual embedding: the fixture
 * corpus hotlinks placehold.co text-on-gray tiles which (a) are served as SVG
 * (PIL can't decode) and (b) would all cluster together and pollute visual
 * search if rasterized. Listings skipped here simply stay on the
 * attribute-vector similarity path.
 */
const PLACEHOLDER_HOSTS = new Set(['placehold.co', 'via.placeholder.com']);

export function isPlaceholderImage(url: string): boolean {
  try {
    return PLACEHOLDER_HOSTS.has(new URL(url).hostname);
  } catch {
    return true; // unparseable url — nothing to embed
  }
}

/** The slice of EmbedderProcess the ingest step needs (mockable in tests). */
export interface EmbedderBridge {
  embed(req: { imageUrl: string }): Promise<Float32Array>;
  endInput(): void;
  dispose(): Promise<void>;
}

/** Injection seams for tests — production defaults hit the real sidecar. */
export interface EmbedOnIngestDeps {
  resolvePaths?: () => EmbedderPaths | null;
  createEmbedder?: (paths: EmbedderPaths) => EmbedderBridge;
}

export interface EmbedOnIngestResult {
  /** missing-vector tasks for the affected sources (after placeholder filter) */
  queued: number;
  embedded: number;
  failed: number;
  /** why nothing ran (null when the embed batch actually executed) */
  skipped: 'no_sidecar' | 'nothing_missing' | null;
}

/**
 * Embed CURRENT-content-hash vectors for exactly the listings of
 * `sourceIds` that miss one (listing ids are `${sourceId}:${sourceListingId}`,
 * so the shared missing-embedding queue is narrowed to this run's sources).
 */
export async function embedMissingForSources(
  db: Db,
  sourceIds: string[],
  logger: Logger,
  deps: EmbedOnIngestDeps = {},
): Promise<EmbedOnIngestResult> {
  const prefixes = sourceIds.map((s) => `${s}:`);
  const tasks = listingsMissingEmbedding(db, EMBEDDING_MODEL_TAG).filter(
    (t) =>
      prefixes.some((p) => t.listingId.startsWith(p)) && !isPlaceholderImage(t.imageUrl),
  );
  if (tasks.length === 0) {
    // observable in prod logs: the step RAN and found nothing to embed (e.g.
    // the fixture corpus — placeholder-host images are excluded by design)
    logger.info(
      '[embed] embed-on-ingest: no listings missing vectors for this run (placeholder images excluded by design)',
    );
    return { queued: 0, embedded: 0, failed: 0, skipped: 'nothing_missing' };
  }

  const paths = (deps.resolvePaths ?? resolveEmbedder)();
  if (!paths) {
    // not an error — the app keeps working on attribute-vector similarity
    logger.info(
      `[embed] ml sidecar not set up — skipping embed-on-ingest for ${tasks.length} listing(s) ` +
        '(run `npm run ml:setup` to enable; `npm run embed` backfills later)',
    );
    return { queued: tasks.length, embedded: 0, failed: 0, skipped: 'no_sidecar' };
  }

  const createEmbedder =
    deps.createEmbedder ??
    ((p: EmbedderPaths): EmbedderBridge => new EmbedderProcess({ paths: p, batchSize: 8, timeoutMs: 0 }));
  const embedder = createEmbedder(paths);
  logger.info(`[embed] embedding ${tasks.length} new/changed listing(s) (${EMBEDDING_MODEL_TAG}, local compute)`);

  let embedded = 0;
  let failed = 0;
  const work = tasks.map(async (task) => {
    try {
      const vector = await embedder.embed({ imageUrl: task.imageUrl });
      upsertEmbedding(db, {
        listingId: task.listingId,
        contentHash: task.contentHash,
        model: EMBEDDING_MODEL_TAG,
        vector,
        imageUrl: task.imageUrl,
      });
      embedded += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        `[embed] ${task.listingId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  // all requests are written on call; EOF flushes the sidecar's final batch
  embedder.endInput();
  await Promise.all(work);
  await embedder.dispose();

  return { queued: tasks.length, embedded, failed, skipped: null };
}
