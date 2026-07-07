/**
 * Ingest pipeline — docs/ARCHITECTURE.md §8.
 * fetchListings → upsert listings (bump last_seen_at, recompute content_hash)
 * → diff → enqueue changed hashes for extraction → flush batch → log ingest_run.
 *
 * Upsert semantics (doc §3):
 * - re-seen & unchanged  → bump last_seen_at (+ availability), revive removed_at
 * - re-seen & changed    → full field update, new content_hash, images replaced
 * - never seen           → insert listing + images
 * - explicitly gone      → removed_at = now (FetchResult.removedSourceListingIds)
 * - unseen for 2×cadence → removed_at = now (freshness.ts pruneStale)
 * Health bookkeeping: one ingest_runs row per run + sources.last_run_at, read
 * by the backend admin endpoint (product spec G1).
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  RawListingSchema,
  type FetchResult,
  type Logger,
  type RawListing,
  type SourceConnector,
} from '@hemline/contracts';
import { createEtagCache } from '@hemline/connectors';
import { ingestRuns, listingImages, listings, sources, type Db } from '@hemline/db';
import { buildPendingExtractionInputs, runExtraction } from './extraction';
import { pruneStale } from './freshness';

export interface PipelineStats {
  fetched: number;
  new: number;
  updated: number;
  unchanged: number;
  errors: number;
  removed: number;
  pruned: number;
  extracted: number;
  extractionPending: number;
  mock: boolean;
}

export interface PipelineResult {
  runId: number;
  status: 'ok' | 'error';
  stats: PipelineStats;
}

export interface PipelineOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: number;
  /** skip the extraction hand-off (tests / --no-extract) */
  extract?: boolean;
  /** skip the 2×cadence staleness pass */
  prune?: boolean;
}

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(msg, ...(meta ? [meta] : [])),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/** content_hash = sha256(title|desc|price|images|sizes) — doc §7.2.
 * (Same recipe as packages/db/src/seed.ts, which cannot be imported: it runs
 * the seed on import.) */
export function contentHashFor(e: {
  title: string;
  description?: string;
  priceCents: number;
  imageUrls: string[];
  sizeLabels: string[];
}): string {
  return createHash('sha256')
    .update(
      [
        e.title,
        e.description ?? '',
        String(e.priceCents),
        e.imageUrls.join(','),
        e.sizeLabels.join(','),
      ].join('|'),
    )
    .digest('hex');
}

function ensureSourceRow(
  db: Db,
  id: string,
  connector: SourceConnector,
  displayName = id,
): void {
  db.insert(sources)
    .values({
      id,
      kind: connector.kind,
      displayName,
      cadenceCron: connector.defaultCadence,
    })
    .onConflictDoNothing()
    .run();
}

export async function runPipeline(
  db: Db,
  connector: SourceConnector,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? consoleLogger;
  const startedAt = opts.now ?? Date.now();
  const mockMode = !connector.isConfigured(env);

  ensureSourceRow(db, connector.id, connector);
  const [run] = db
    .insert(ingestRuns)
    .values({ sourceId: connector.id, startedAt, status: 'running' })
    .returning({ id: ingestRuns.id })
    .all();
  const runId = run.id;

  const stats: PipelineStats = {
    fetched: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    removed: 0,
    pruned: 0,
    extracted: 0,
    extractionPending: 0,
    mock: mockMode,
  };

  const finalize = (status: 'ok' | 'error', error?: string): PipelineResult => {
    const finishedAt = Date.now();
    db.update(ingestRuns)
      .set({ finishedAt, status, statsJson: JSON.stringify(stats), error: error ?? null })
      .where(eq(ingestRuns.id, runId))
      .run();
    db.update(sources).set({ lastRunAt: finishedAt }).where(eq(sources.id, connector.id)).run();
    return { runId, status, stats };
  };

  // ── fetch ────────────────────────────────────────────────────────────
  let result: FetchResult;
  try {
    result = await connector.fetchListings({
      db,
      etagCache: createEtagCache(connector.id, db),
      logger,
      mockMode,
    });
  } catch (e) {
    stats.errors += 1;
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[ingest:${connector.id}] fetch failed: ${msg}`);
    return finalize('error', msg);
  }
  stats.fetched = result.stats.fetched;
  stats.errors += result.stats.errors;

  // ── validate + upsert ────────────────────────────────────────────────
  const valid: RawListing[] = [];
  for (const raw of result.listings) {
    const parsed = RawListingSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else {
      stats.errors += 1;
      logger.warn(`[ingest:${connector.id}] invalid RawListing dropped`, parsed.error.issues[0]);
    }
  }

  // Listings may carry sub-source ids (fixtures → fixture:shopify/fixture:ebay);
  // each distinct sourceId needs a sources row for the FK + bookkeeping.
  const rawSourceIds = [...new Set(valid.map((l) => l.sourceId))];
  for (const sid of rawSourceIds) {
    if (sid !== connector.id) ensureSourceRow(db, sid, connector, sid);
  }
  const affectedSourceIds = [...new Set([connector.id, ...rawSourceIds])];

  try {
    db.transaction((tx) => {
      const existingRows =
        rawSourceIds.length === 0
          ? []
          : tx
              .select({
                id: listings.id,
                contentHash: listings.contentHash,
              })
              .from(listings)
              .where(inArray(listings.sourceId, rawSourceIds))
              .all();
      const existing = new Map(existingRows.map((r) => [r.id, r.contentHash]));

      for (const raw of valid) {
        const id = `${raw.sourceId}:${raw.sourceListingId}`;
        const hash = contentHashFor(raw);
        const prevHash = existing.get(id);

        if (prevHash === undefined) {
          tx.insert(listings)
            .values({
              id,
              sourceId: raw.sourceId,
              sourceListingId: raw.sourceListingId,
              sourceUrl: raw.sourceUrl,
              affiliateUrl: raw.affiliateUrl ?? null,
              title: raw.title,
              description: raw.description ?? null,
              brand: raw.brand ?? null,
              priceCents: raw.priceCents,
              currency: raw.currency,
              condition: raw.condition ?? 'unknown',
              isVintage: raw.isVintage ?? false,
              era: raw.era ?? null,
              sizeLabelsJson: JSON.stringify(raw.sizeLabels),
              availabilityJson: JSON.stringify(raw.availability ?? {}),
              contentHash: hash,
              firstSeenAt: raw.seenAt,
              lastSeenAt: raw.seenAt,
              removedAt: null,
            })
            .run();
          if (raw.imageUrls.length > 0) {
            tx.insert(listingImages)
              .values(raw.imageUrls.map((url, position) => ({ listingId: id, url, position })))
              .run();
          }
          stats.new += 1;
        } else if (prevHash === hash) {
          // unchanged content — freshness bump (+ availability, which is not hashed)
          tx.update(listings)
            .set({
              lastSeenAt: raw.seenAt,
              availabilityJson: JSON.stringify(raw.availability ?? {}),
              removedAt: null,
            })
            .where(eq(listings.id, id))
            .run();
          stats.unchanged += 1;
        } else {
          tx.update(listings)
            .set({
              sourceUrl: raw.sourceUrl,
              affiliateUrl: raw.affiliateUrl ?? null,
              title: raw.title,
              description: raw.description ?? null,
              brand: raw.brand ?? null,
              priceCents: raw.priceCents,
              currency: raw.currency,
              condition: raw.condition ?? 'unknown',
              isVintage: raw.isVintage ?? false,
              era: raw.era ?? null,
              sizeLabelsJson: JSON.stringify(raw.sizeLabels),
              availabilityJson: JSON.stringify(raw.availability ?? {}),
              contentHash: hash,
              lastSeenAt: raw.seenAt,
              removedAt: null,
            })
            .where(eq(listings.id, id))
            .run();
          replaceImagesTx(tx, id, raw.imageUrls);
          stats.updated += 1;
        }
      }

      // ── explicit removals ──────────────────────────────────────────────
      const gone = result.removedSourceListingIds ?? [];
      if (gone.length > 0) {
        const res = tx
          .update(listings)
          .set({ removedAt: startedAt })
          .where(
            and(
              inArray(listings.sourceId, affectedSourceIds),
              inArray(listings.sourceListingId, gone),
            ),
          )
          .run();
        stats.removed = res.changes;
      }
    });
  } catch (e) {
    stats.errors += 1;
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[ingest:${connector.id}] upsert failed: ${msg}`);
    return finalize('error', msg);
  }

  // ── freshness decay: unseen for 2× cadence → soft delete ────────────
  if (opts.prune !== false) {
    stats.pruned = pruneStale(db, affectedSourceIds, connector.defaultCadence, {
      now: startedAt,
    });
  }

  // ── extraction hand-off (isolated; stub-safe) ────────────────────────
  if (opts.extract !== false) {
    const inputs = buildPendingExtractionInputs(db, affectedSourceIds);
    const outcome = await runExtraction(db, inputs, logger, env);
    stats.extracted = outcome.extracted;
    stats.extractionPending = outcome.pending;
  }

  logger.info(
    `[ingest:${connector.id}] ${mockMode ? '[MOCK] ' : ''}fetched=${stats.fetched} new=${stats.new} updated=${stats.updated} unchanged=${stats.unchanged} removed=${stats.removed} pruned=${stats.pruned} errors=${stats.errors} extraction: ${stats.extracted} done / ${stats.extractionPending} pending`,
  );
  return finalize('ok');
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function replaceImagesTx(tx: Tx, listingId: string, imageUrls: string[]): void {
  tx.delete(listingImages).where(eq(listingImages.listingId, listingId)).run();
  if (imageUrls.length > 0) {
    tx.insert(listingImages)
      .values(imageUrls.map((url, position) => ({ listingId, url, position })))
      .run();
  }
}
