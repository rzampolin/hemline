/**
 * Length-estimation queue + run loop (core of `npm run extract:lengths`).
 *
 * Targets extraction rows with length_inches IS NULL that belong to a live
 * (not removed) listing with a primary image. Idempotent/resumable: every
 * attempted row gets length_basis='image_estimate' (even when the model could
 * not estimate or the estimate was clamped), so re-runs skip it; rows whose
 * call FAILED (network/API error) stay unmarked and are retried on resume.
 * `model IN ('manual','fixture')` rows are protected (same PROTECTED_MODELS
 * rule as the ai-cache store) — human QA and seed ground truth are never
 * touched.
 *
 * Estimates are ESTIMATES: they are written with length_basis='image_estimate'
 * so packages/matching computes hem confidence 'medium' (§5 fallback 1) and
 * the UI styles them as estimated, never "Measured".
 */
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { LengthClass, Logger } from '@hemline/contracts';
import { extractions, listingImages, listings, type Db } from '@hemline/db';
import type { LengthEstimateInput, LengthEstimator } from '@hemline/ai';

export interface LengthEstimateTarget extends LengthEstimateInput {
  listingId: string;
}

/** Extraction rows still needing a length estimate (idempotent selection). */
export function buildLengthEstimateTargets(db: Db, limit = 100_000): LengthEstimateTarget[] {
  const rows = db
    .select({
      contentHash: extractions.contentHash,
      listingId: extractions.listingId,
      lengthClass: extractions.lengthClass,
      silhouette: extractions.silhouette,
      title: listings.title,
      imageUrl: listingImages.url,
    })
    .from(extractions)
    .innerJoin(
      listings,
      and(eq(listings.id, extractions.listingId), isNull(listings.removedAt)),
    )
    .innerJoin(
      listingImages,
      and(eq(listingImages.listingId, listings.id), sql`${listingImages.position} = 0`),
    )
    .where(
      and(
        isNull(extractions.lengthInches),
        isNull(extractions.lengthBasis), // not yet attempted
        notInArray(extractions.model, ['manual', 'fixture']),
      ),
    )
    .limit(limit)
    .all();

  return rows.map((r) => ({
    listingId: r.listingId,
    contentHash: r.contentHash,
    primaryImageUrl: r.imageUrl,
    title: r.title,
    lengthClass: (r.lengthClass ?? null) as LengthClass | null,
    silhouette: r.silhouette ?? null,
  }));
}

export interface LengthEstimationRunResult {
  attempted: number;
  estimated: number;
  clamped: number;
  noEstimate: number;
  failed: number;
  /** true when the run stopped early (budget cap / keyless) */
  stopped: boolean;
}

export interface LengthEstimationRunOptions {
  concurrency?: number;
  /** budget/abort check, evaluated before each wave; return true to stop */
  shouldStop?: () => boolean;
  /** progress callback after each wave (processed count so far) */
  onProgress?: (processed: number) => void;
}

/**
 * Drive the estimator over the targets with chunked concurrency (same wave
 * pattern as the extraction service) and update rows in place.
 */
export async function runLengthEstimation(
  db: Db,
  targets: LengthEstimateTarget[],
  estimator: LengthEstimator,
  logger: Logger,
  options: LengthEstimationRunOptions = {},
): Promise<LengthEstimationRunResult> {
  const concurrency = options.concurrency ?? 5;
  const result: LengthEstimationRunResult = {
    attempted: 0,
    estimated: 0,
    clamped: 0,
    noEstimate: 0,
    failed: 0,
    stopped: false,
  };

  for (let i = 0; i < targets.length; i += concurrency) {
    if (options.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    const wave = targets.slice(i, i + concurrency);
    const outcomes = await Promise.all(wave.map((t) => estimator.estimateOne(t)));
    let waveFailures = 0;
    for (let j = 0; j < wave.length; j++) {
      const target = wave[j];
      const outcome = outcomes[j];
      result.attempted += 1;
      switch (outcome.status) {
        case 'estimated':
          result.estimated += 1;
          db.update(extractions)
            .set({ lengthInches: outcome.lengthInches, lengthBasis: 'image_estimate' })
            .where(eq(extractions.contentHash, target.contentHash))
            .run();
          break;
        case 'clamped':
          // distrusted estimate — keep the class prior (no inches), but mark
          // attempted so the queue never re-pays for this photo
          result.clamped += 1;
          db.update(extractions)
            .set({ lengthBasis: 'image_estimate' })
            .where(eq(extractions.contentHash, target.contentHash))
            .run();
          break;
        case 'no_estimate':
          result.noEstimate += 1;
          db.update(extractions)
            .set({ lengthBasis: 'image_estimate' })
            .where(eq(extractions.contentHash, target.contentHash))
            .run();
          break;
        case 'failed':
          // leave unmarked → retried on resume
          result.failed += 1;
          waveFailures += 1;
          logger.warn(
            `[lengths] ${target.contentHash.slice(0, 12)}… failed: ${outcome.error ?? 'unknown'}`,
          );
          break;
      }
    }
    options.onProgress?.(Math.min(i + concurrency, targets.length));
    // an all-failure wave usually means budget cap / dead key — stop cleanly
    if (waveFailures === wave.length) {
      result.stopped = true;
      break;
    }
  }
  return result;
}

/** Coverage snapshot for the CLI's final report. */
export function lengthCoverage(db: Db): {
  liveListings: number;
  withInches: number;
  stated: number;
  imageEstimated: number;
  withClass: number;
} {
  const row = db.get<{
    liveListings: number;
    withInches: number;
    stated: number;
    imageEstimated: number;
    withClass: number;
  }>(sql`
    SELECT
      COUNT(*) AS liveListings,
      SUM(CASE WHEN e.length_inches IS NOT NULL THEN 1 ELSE 0 END) AS withInches,
      SUM(CASE WHEN e.length_inches IS NOT NULL AND (e.length_basis IS NULL OR e.length_basis = 'stated') THEN 1 ELSE 0 END) AS stated,
      SUM(CASE WHEN e.length_inches IS NOT NULL AND e.length_basis = 'image_estimate' THEN 1 ELSE 0 END) AS imageEstimated,
      SUM(CASE WHEN e.length_class IS NOT NULL THEN 1 ELSE 0 END) AS withClass
    FROM listings l
    LEFT JOIN extractions e ON e.listing_id = l.id
    WHERE l.removed_at IS NULL
  `);
  return {
    liveListings: row?.liveListings ?? 0,
    withInches: row?.withInches ?? 0,
    stated: row?.stated ?? 0,
    imageEstimated: row?.imageEstimated ?? 0,
    withClass: row?.withClass ?? 0,
  };
}
