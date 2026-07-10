/**
 * Kids-listing purge (founder-reported prod bug, 2026-07-09): CHILDREN's
 * dresses reached the catalog because the dress filter asked "is it a dress?"
 * but never "for whom?". The connectors now gate on audience at ingest
 * (@hemline/connectors detectChildAudience + per-store kidsCollections /
 * excludeUrlPatterns) and the extraction pipeline writes an `audience` column
 * — this module cleans up the EXISTING rows.
 *
 * Two passes:
 *
 * 1. Heuristic scan (free, deterministic): the SAME layer-1 audience gate the
 *    connectors use, over each active listing's TITLE + size labels. The
 *    description is deliberately excluded — adult PDPs cross-sell "mini me"
 *    versions in body copy. Dry-run reports per-store counts + sample titles;
 *    --apply soft-deletes (removed_at = now, the verifier's own semantics —
 *    feed/search exclude removed rows, saves keep them for the rack UX).
 *    Idempotent: removed rows are never re-scanned.
 *
 * 2. Vision recheck (--recheck-vision, paid, bounded): SUSPECTS ONLY —
 *    active listings from stores with KNOWN kids lines whose extraction lacks
 *    an audience verdict and which pass 1 could not flag (the Dôen case:
 *    adult-reading metadata, sizes 2–10, child model in the photo). One cheap
 *    Haiku image call each (@hemline/ai createAudienceChecker), cost-quoted
 *    upfront from the REAL calibration ($5.81 / 9,981 calls ≈ $0.0006/call,
 *    2026-07-08 extraction pass) and budget-guarded. Verdicts are persisted
 *    to extractions.audience either way (paid answers are never thrown away);
 *    child verdicts soft-delete only under --apply.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Logger } from '@hemline/contracts';
import { detectChildAudience } from '@hemline/connectors';
import { extractions, listingImages, listings, type Db } from '@hemline/db';
import type { AudienceChecker } from '@hemline/ai';

/**
 * REAL calibration: last night's full-catalog Haiku pass cost $5.81 for
 * 9,981 image+text calls → ≈ $0.000582/call; quoted at $0.0006. The audience
 * question needs FEWER output tokens (~10 vs ~150), so this is conservative.
 */
export const VISION_COST_PER_CALL_USD = 0.0006;

/** Stores with confirmed kids lines (vision-recheck suspect pool). */
export const KNOWN_KIDS_LINE_SOURCE_IDS = [
  'shopify:shopdoen.com', // Dôen kids: zero metadata signal (probed 2026-07-09)
  'shopify:loveshackfancy.com', // LSF girls line (usually caught by keywords)
];

export interface KidsFlaggedListing {
  listingId: string;
  sourceId: string;
  title: string;
  sizeLabels: string[];
  reason: string;
}

export interface KidsScanReport {
  scanned: number;
  flagged: KidsFlaggedListing[];
  perStore: Record<string, { count: number; sampleTitles: string[] }>;
}

/** Pass 1: layer-1 heuristics over active listings (free, deterministic). */
export function scanKidsListings(db: Db): KidsScanReport {
  const rows = db
    .select({
      id: listings.id,
      sourceId: listings.sourceId,
      title: listings.title,
      sizeLabelsJson: listings.sizeLabelsJson,
    })
    .from(listings)
    .where(isNull(listings.removedAt))
    .all();

  const flagged: KidsFlaggedListing[] = [];
  for (const row of rows) {
    let sizeLabels: string[] = [];
    try {
      sizeLabels = JSON.parse(row.sizeLabelsJson) as string[];
    } catch {
      /* bad JSON → no size signal */
    }
    const verdict = detectChildAudience({ text: row.title, sizeLabels });
    if (verdict.child) {
      flagged.push({
        listingId: row.id,
        sourceId: row.sourceId,
        title: row.title,
        sizeLabels,
        reason: verdict.reason ?? 'unknown',
      });
    }
  }

  const perStore: KidsScanReport['perStore'] = {};
  for (const f of flagged) {
    const entry = (perStore[f.sourceId] ??= { count: 0, sampleTitles: [] });
    entry.count += 1;
    if (entry.sampleTitles.length < 5) entry.sampleTitles.push(`${f.title} [${f.reason}]`);
  }
  return { scanned: rows.length, flagged, perStore };
}

export interface PurgeResult {
  applied: boolean;
  scanned: number;
  flagged: number;
  removed: number;
  perStore: KidsScanReport['perStore'];
  /** keyword-flagged but vision says adult — false positives, never removed */
  visionCleared: KidsFlaggedListing[];
}

/**
 * Soft-delete the heuristic-flagged listings (removed_at = now — verifier
 * semantics). Dry-run (apply=false) only reports. Idempotent: a second
 * --apply run scans 0 flagged rows (removed_at IS NULL filter).
 *
 * VISION OVERRIDE (2026-07-09, prod dry-run finding): keyword flags have
 * name-copy false positives (Selkie's adult "Baby Soft" collection, Motel
 * Rocks' "Star Child" print). A persisted vision verdict of audience='adult'
 * OUTRANKS a keyword flag — those listings are reported (visionCleared) but
 * never removed. Run --recheck-vision first for exactly this reason.
 */
export function purgeKids(db: Db, opts: { apply: boolean; now?: number }): PurgeResult {
  const now = opts.now ?? Date.now();
  const report = scanKidsListings(db);
  // vision-cleared: extraction says adult → keyword flag is a false positive
  const flaggedIds = report.flagged.map((f) => f.listingId);
  const adultVerdicts = new Set<string>();
  for (let i = 0; i < flaggedIds.length; i += 500) {
    const rows = db
      .select({ listingId: extractions.listingId })
      .from(extractions)
      .where(
        and(
          inArray(extractions.listingId, flaggedIds.slice(i, i + 500)),
          eq(extractions.audience, 'adult'),
        ),
      )
      .all();
    for (const r of rows) adultVerdicts.add(r.listingId);
  }
  const visionCleared = report.flagged.filter((f) => adultVerdicts.has(f.listingId));
  report.flagged = report.flagged.filter((f) => !adultVerdicts.has(f.listingId));
  let removed = 0;
  if (opts.apply && report.flagged.length > 0) {
    const ids = report.flagged.map((f) => f.listingId);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = db
        .update(listings)
        .set({ removedAt: now })
        .where(and(inArray(listings.id, chunk), isNull(listings.removedAt)))
        .run();
      removed += res.changes;
    }
    // record the verdict on any extraction rows too, so the audience filter
    // and future re-ingests agree with the purge
    for (let i = 0; i < ids.length; i += 500) {
      db.update(extractions)
        .set({ audience: 'child' })
        .where(inArray(extractions.listingId, ids.slice(i, i + 500)))
        .run();
    }
  }
  return {
    applied: opts.apply,
    scanned: report.scanned,
    flagged: report.flagged.length,
    removed,
    perStore: report.perStore,
    visionCleared,
  };
}

export interface VisionSuspect {
  listingId: string;
  contentHash: string;
  sourceId: string;
  title: string;
  sizeLabels: string[];
  primaryImageUrl: string | null;
}

/**
 * Suspect pool for the vision recheck: ACTIVE listings from known-kids-line
 * stores with NO extraction audience verdict yet. Heuristic-flagged listings
 * are excluded — pass 1 already handles them for free.
 */
export function findVisionSuspects(
  db: Db,
  sourceIds: string[] = KNOWN_KIDS_LINE_SOURCE_IDS,
): VisionSuspect[] {
  if (sourceIds.length === 0) return [];
  const rows = db
    .select({
      id: listings.id,
      contentHash: listings.contentHash,
      sourceId: listings.sourceId,
      title: listings.title,
      sizeLabelsJson: listings.sizeLabelsJson,
    })
    .from(listings)
    .where(
      and(
        inArray(listings.sourceId, sourceIds),
        isNull(listings.removedAt),
        sql`NOT EXISTS (SELECT 1 FROM extractions e WHERE e.listing_id = ${listings.id} AND e.audience IS NOT NULL)`,
      ),
    )
    .all();
  if (rows.length === 0) return [];

  const imageRows = db
    .select({ listingId: listingImages.listingId, url: listingImages.url })
    .from(listingImages)
    .where(
      and(
        inArray(
          listingImages.listingId,
          rows.map((r) => r.id),
        ),
        eq(listingImages.position, 0),
      ),
    )
    .all();
  const primaryImage = new Map(imageRows.map((r) => [r.listingId, r.url]));

  return rows
    .map((row) => {
      let sizeLabels: string[] = [];
      try {
        sizeLabels = JSON.parse(row.sizeLabelsJson) as string[];
      } catch {
        /* no size signal */
      }
      return {
        listingId: row.id,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        title: row.title,
        sizeLabels,
        primaryImageUrl: primaryImage.get(row.id) ?? null,
      };
    })
    .filter((s) => !detectChildAudience({ text: s.title, sizeLabels: s.sizeLabels }).child);
}

export interface VisionRecheckResult {
  suspects: number;
  checked: number;
  child: number;
  adult: number;
  undecided: number;
  imageUnavailable: number;
  failed: number;
  removed: number;
  /** listings the budget cap left unchecked (resume with a fresh budget) */
  skippedForBudget: number;
  costUsd: number;
  childTitles: string[];
}

/**
 * Vision recheck over the suspect pool, budget-guarded: at most
 * floor(budgetUsd / VISION_COST_PER_CALL_USD) calls, and the loop also stops
 * if the checker's METERED spend crosses the budget. Verdicts are persisted to
 * extractions.audience regardless of `apply` (paid answers are kept);
 * child-flagged listings are soft-deleted only when apply=true.
 */
export async function recheckVision(
  db: Db,
  suspects: VisionSuspect[],
  checker: AudienceChecker,
  opts: { apply: boolean; budgetUsd: number; now?: number; logger?: Logger },
): Promise<VisionRecheckResult> {
  const now = opts.now ?? Date.now();
  const log = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const result: VisionRecheckResult = {
    suspects: suspects.length,
    checked: 0,
    child: 0,
    adult: 0,
    undecided: 0,
    imageUnavailable: 0,
    failed: 0,
    removed: 0,
    skippedForBudget: 0,
    costUsd: 0,
    childTitles: [],
  };

  const maxCalls = Math.floor(opts.budgetUsd / VISION_COST_PER_CALL_USD);
  const withImage = suspects.filter((s) => s.primaryImageUrl != null);
  const toCheck = withImage.slice(0, maxCalls);
  result.skippedForBudget = withImage.length - toCheck.length;
  result.imageUnavailable += suspects.length - withImage.length;

  let consecutiveFailures = 0;
  let processed = 0;
  for (const suspect of toCheck) {
    if (checker.costUsd() >= opts.budgetUsd) {
      result.skippedForBudget += toCheck.length - processed;
      log.warn(
        `[purge-kids] metered spend $${checker.costUsd().toFixed(4)} reached the budget — stopping`,
      );
      break;
    }
    processed += 1;
    const verdict = await checker.checkOne({
      contentHash: suspect.contentHash,
      primaryImageUrl: suspect.primaryImageUrl!,
      title: suspect.title,
      sizeLabels: suspect.sizeLabels,
    });
    if (verdict.status === 'failed') {
      result.failed += 1;
      consecutiveFailures += 1;
      log.warn(`[purge-kids] ${suspect.listingId} vision check failed: ${verdict.error}`);
      if (consecutiveFailures >= 5) {
        log.warn('[purge-kids] 5 consecutive failures — aborting the vision pass');
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    if (verdict.status === 'image_unavailable') {
      result.imageUnavailable += 1;
      continue;
    }
    result.checked += 1;
    if (verdict.audience === null) {
      result.undecided += 1;
      continue;
    }
    // persist the paid verdict on the listing's extraction rows (audience is
    // listing-level; multiple content-hash rows may exist)
    const persisted = db
      .update(extractions)
      .set({ audience: verdict.audience })
      .where(eq(extractions.listingId, suspect.listingId))
      .run();
    if (persisted.changes === 0) {
      // no extraction row yet (still pending) — the verdict cannot be stored,
      // so this listing would be re-billed by the next vision run
      log.warn(
        `[purge-kids] ${suspect.listingId}: no extraction row to store the verdict on — run ingest/extraction first`,
      );
    }
    if (verdict.audience === 'child') {
      result.child += 1;
      result.childTitles.push(`${suspect.sourceId} ${suspect.title}`);
      if (opts.apply) {
        const res = db
          .update(listings)
          .set({ removedAt: now })
          .where(and(eq(listings.id, suspect.listingId), isNull(listings.removedAt)))
          .run();
        result.removed += res.changes;
      }
    } else {
      result.adult += 1;
    }
  }
  result.costUsd = checker.costUsd();
  return result;
}

export function formatPurgeReport(r: PurgeResult): string {
  const lines: string[] = [
    `[purge-kids] ${r.applied ? 'APPLIED' : 'DRY RUN'}: ${r.scanned} active listing(s) scanned, ` +
      `${r.flagged} flagged as kids items${r.applied ? `, ${r.removed} soft-deleted (removed_at)` : ' (pass --apply to soft-delete)'}`,
  ];
  const stores = Object.entries(r.perStore).sort((a, b) => b[1].count - a[1].count);
  for (const [sourceId, { count, sampleTitles }] of stores) {
    lines.push(`[purge-kids]   ${sourceId}: ${count}`);
    for (const t of sampleTitles) lines.push(`[purge-kids]     - ${t}`);
  }
  if (r.visionCleared.length > 0) {
    lines.push(
      `[purge-kids] ${r.visionCleared.length} keyword flag(s) CLEARED by vision verdict (audience=adult) — kept:`,
    );
    for (const f of r.visionCleared.slice(0, 10)) {
      lines.push(`[purge-kids]     ✓ ${f.title} [${f.reason}]`);
    }
  }
  return lines.join('\n');
}
