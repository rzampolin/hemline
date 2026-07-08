/**
 * Length-estimation queue + run loop (core of `npm run extract:lengths`).
 *
 * Targets extraction rows with length_inches IS NULL that belong to a live
 * (not removed) listing with a primary image. Idempotent/resumable: sane
 * estimates get length_basis='image_estimate' (inches ALWAYS present);
 * clamped / not-estimable attempts get length_basis='not_estimable' (inches
 * ALWAYS NULL) — both are skipped on re-run; rows whose call FAILED
 * (network/API error) stay unmarked and are retried on resume.
 * `model IN ('manual','fixture')` rows are protected (same PROTECTED_MODELS
 * rule as the ai-cache store) — human QA and seed ground truth are never
 * touched.
 *
 * v2 anchoring: the free deterministic parser (parseModelInfo) pulls the
 * STATED model height from listing text ("Model is 5'10" and wears a size S")
 * so the vision prompt anchors on the actual model instead of the assumed
 * 5'9"; the anchor used is recorded in length_anchor/length_anchor_height_in.
 * `--reanchor` re-runs default-anchored estimates whose listing states a
 * height differing from 69" by ≥ REANCHOR_MIN_DELTA_IN.
 *
 * Estimates are ESTIMATES: they are written with length_basis='image_estimate'
 * so packages/matching computes hem confidence 'medium' (§5 fallback 1) and
 * the UI styles them as estimated, never "Measured".
 */
import { and, eq, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { LengthClass, Logger } from '@hemline/contracts';
import { extractions, listingImages, listings, type Db } from '@hemline/db';
import { parseModelInfo, type LengthEstimateInput, type LengthEstimator } from '@hemline/ai';

export interface LengthEstimateTarget extends LengthEstimateInput {
  listingId: string;
}

/**
 * Re-anchor only when the stated height differs from the assumed 69" default
 * by at least this much — smaller deltas can't move the estimate beyond its
 * own noise floor, so re-paying for the call would be waste.
 */
export const REANCHOR_MIN_DELTA_IN = 1;

interface TargetRow {
  contentHash: string;
  listingId: string;
  lengthClass: string | null;
  silhouette: string | null;
  title: string;
  description: string | null;
  imageUrl: string;
}

function toTarget(r: TargetRow): LengthEstimateTarget {
  const modelInfo = parseModelInfo(`${r.title}\n${r.description ?? ''}`);
  return {
    listingId: r.listingId,
    contentHash: r.contentHash,
    primaryImageUrl: r.imageUrl,
    title: r.title,
    lengthClass: (r.lengthClass ?? null) as LengthClass | null,
    silhouette: r.silhouette ?? null,
    statedModelHeightInches: modelInfo.modelHeightInches,
    modelSizeWorn: modelInfo.modelSizeWorn,
  };
}

function selectTargetRows(db: Db) {
  return db
    .select({
      contentHash: extractions.contentHash,
      listingId: extractions.listingId,
      lengthClass: extractions.lengthClass,
      silhouette: extractions.silhouette,
      title: listings.title,
      description: listings.description,
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
    );
}

/**
 * Extraction rows still needing a length estimate (idempotent selection).
 * Stated model heights are parsed (free) so fresh runs anchor correctly the
 * first time.
 */
export function buildLengthEstimateTargets(db: Db, limit = 100_000): LengthEstimateTarget[] {
  const rows = selectTargetRows(db)
    .where(
      and(
        isNull(extractions.lengthInches),
        isNull(extractions.lengthBasis), // not yet attempted
        notInArray(extractions.model, ['manual', 'fixture']),
      ),
    )
    .limit(limit)
    .all();
  return rows.map(toTarget);
}

export interface ReanchorScan {
  /** re-estimation targets: default-anchored + stated height ≥1" off 69" */
  targets: LengthEstimateTarget[];
  /** image-estimated rows scanned (not yet anchored on a stated height) */
  scanned: number;
  /** of those, listings whose text states a parseable model height */
  withStatedHeight: number;
}

/**
 * `--reanchor` selection: rows whose inches came from a DEFAULT-anchored
 * vision estimate (basis='image_estimate', anchor NULL — v1 rows — or
 * 'assumed_default') where the listing text states a model height differing
 * from 69" by ≥ REANCHOR_MIN_DELTA_IN. The parse is free/deterministic, so
 * the scan runs BEFORE any cost is quoted. Idempotent: rows re-estimated with
 * anchor='stated_model_height' are never selected again.
 */
export function buildReanchorTargets(db: Db, limit = 100_000): ReanchorScan {
  const rows = selectTargetRows(db)
    .where(
      and(
        eq(extractions.lengthBasis, 'image_estimate'),
        isNotNull(extractions.lengthInches),
        or(isNull(extractions.lengthAnchor), eq(extractions.lengthAnchor, 'assumed_default')),
        notInArray(extractions.model, ['manual', 'fixture']),
      ),
    )
    .limit(limit)
    .all();

  const scan: ReanchorScan = { targets: [], scanned: rows.length, withStatedHeight: 0 };
  for (const row of rows) {
    const target = toTarget(row);
    if (target.statedModelHeightInches == null) continue;
    scan.withStatedHeight += 1;
    if (Math.abs(target.statedModelHeightInches - 69) >= REANCHOR_MIN_DELTA_IN) {
      scan.targets.push(target);
    }
  }
  return scan;
}

/**
 * Bookkeeping fix (v2, no API calls): v1 marked clamped/not-estimable
 * attempts with length_basis='image_estimate' and NULL inches; re-mark them
 * 'not_estimable' so basis='image_estimate' always implies inches present.
 * Idempotent; returns the number of rows migrated.
 */
export function migrateLengthBookkeeping(db: Db): number {
  const result = db
    .update(extractions)
    .set({ lengthBasis: 'not_estimable' })
    .where(and(eq(extractions.lengthBasis, 'image_estimate'), isNull(extractions.lengthInches)))
    .run();
  return Number(result.changes ?? 0);
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
            .set({
              lengthInches: outcome.lengthInches,
              lengthBasis: 'image_estimate',
              lengthAnchor: outcome.anchor,
              lengthAnchorHeightIn: outcome.anchorHeightInches,
            })
            .where(eq(extractions.contentHash, target.contentHash))
            .run();
          break;
        case 'clamped':
        case 'no_estimate':
          // distrusted / impossible estimate — keep the class prior (inches
          // NULL, and any prior default-anchored inches are withdrawn), but
          // mark 'not_estimable' so the queue never re-pays for this photo
          if (outcome.status === 'clamped') result.clamped += 1;
          else result.noEstimate += 1;
          db.update(extractions)
            .set({
              lengthInches: null,
              lengthBasis: 'not_estimable',
              lengthAnchor: outcome.anchor,
              lengthAnchorHeightIn: outcome.anchorHeightInches,
            })
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
  /** of imageEstimated: anchored on a stated model height (v2) */
  anchoredStatedHeight: number;
  /** vision pass attempted, no trustworthy inches (clamped / not estimable) */
  notEstimable: number;
  withClass: number;
} {
  const row = db.get<{
    liveListings: number;
    withInches: number;
    stated: number;
    imageEstimated: number;
    anchoredStatedHeight: number;
    notEstimable: number;
    withClass: number;
  }>(sql`
    SELECT
      COUNT(*) AS liveListings,
      SUM(CASE WHEN e.length_inches IS NOT NULL THEN 1 ELSE 0 END) AS withInches,
      SUM(CASE WHEN e.length_inches IS NOT NULL AND (e.length_basis IS NULL OR e.length_basis = 'stated') THEN 1 ELSE 0 END) AS stated,
      SUM(CASE WHEN e.length_inches IS NOT NULL AND e.length_basis = 'image_estimate' THEN 1 ELSE 0 END) AS imageEstimated,
      SUM(CASE WHEN e.length_inches IS NOT NULL AND e.length_basis = 'image_estimate' AND e.length_anchor = 'stated_model_height' THEN 1 ELSE 0 END) AS anchoredStatedHeight,
      SUM(CASE WHEN e.length_basis = 'not_estimable' THEN 1 ELSE 0 END) AS notEstimable,
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
    anchoredStatedHeight: row?.anchoredStatedHeight ?? 0,
    notEstimable: row?.notEstimable ?? 0,
    withClass: row?.withClass ?? 0,
  };
}
