/**
 * Extraction hand-off — docs/ARCHITECTURE.md §8, §7.2.
 *
 * The "queue" is the natural one from the schema: listings whose content_hash
 * has no row in `extractions` are pending. After each upsert pass we build
 * ExtractionInputs for pending listings and call the frozen ExtractionService
 * contract (`@hemline/ai`). The service may still be a stub in this worktree,
 * so the call is isolated: any throw leaves the listings pending (they are
 * retried on the next run) and never fails ingest.
 */
import { and, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { ExtractionInput, Logger } from '@hemline/contracts';
import { extractions, listingImages, listings, type Db } from '@hemline/db';

/** Listings of these sources with no extraction row yet → ExtractionInputs. */
export function buildPendingExtractionInputs(
  db: Db,
  sourceIds: string[],
  limit = 500,
): (ExtractionInput & { listingId: string })[] {
  if (sourceIds.length === 0) return [];
  const rows = db
    .select({
      listingId: listings.id,
      contentHash: listings.contentHash,
      title: listings.title,
      description: listings.description,
      brand: listings.brand,
      sizeLabelsJson: listings.sizeLabelsJson,
    })
    .from(listings)
    .where(
      and(
        inArray(listings.sourceId, sourceIds),
        isNull(listings.removedAt),
        notInArray(listings.contentHash, db.select({ h: extractions.contentHash }).from(extractions)),
      ),
    )
    .limit(limit)
    .all();
  if (rows.length === 0) return [];

  const imageRows = db
    .select({ listingId: listingImages.listingId, url: listingImages.url })
    .from(listingImages)
    .where(
      and(
        inArray(
          listingImages.listingId,
          rows.map((r) => r.listingId),
        ),
        sql`${listingImages.position} = 0`,
      ),
    )
    .all();
  const primaryImage = new Map(imageRows.map((r) => [r.listingId, r.url]));

  return rows.map((r) => ({
    listingId: r.listingId,
    contentHash: r.contentHash,
    title: r.title,
    description: r.description,
    brand: r.brand,
    primaryImageUrl: primaryImage.get(r.listingId) ?? null,
    attributeHints: null,
    sizeLabels: JSON.parse(r.sizeLabelsJson) as string[],
  }));
}

export interface ExtractionOutcome {
  /** rows written to `extractions` this run */
  extracted: number;
  /** listings still awaiting extraction (service missing/failed or not returned) */
  pending: number;
}

export async function runExtraction(
  db: Db,
  inputs: (ExtractionInput & { listingId: string })[],
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExtractionOutcome> {
  if (inputs.length === 0) return { extracted: 0, pending: 0 };

  try {
    // Dynamic import: ai-eng's package may be a stub / absent in this worktree.
    const ai = (await import('@hemline/ai')) as {
      createExtractionService?: () => import('@hemline/contracts').ExtractionService;
    };
    if (typeof ai.createExtractionService !== 'function') {
      throw new Error('@hemline/ai does not export createExtractionService');
    }
    const service = ai.createExtractionService();
    const results = await service.extractBatch(
      inputs.map(({ listingId: _listingId, ...input }) => input),
    );

    const model =
      service.mode === 'live' ? (env.EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001') : 'mock';
    const now = Date.now();
    let extracted = 0;
    for (const input of inputs) {
      const attrs = results.get(input.contentHash);
      if (!attrs) continue;
      // onConflictDoNothing: the extraction service/table is ai-eng-owned; if it
      // already cached this hash we never overwrite.
      db.insert(extractions)
        .values({
          contentHash: input.contentHash,
          listingId: input.listingId,
          model,
          lengthClass: attrs.lengthClass,
          lengthInches: attrs.lengthInches,
          measurementsJson: JSON.stringify(attrs.measurements),
          colorsJson: JSON.stringify(attrs.colors),
          fabric: attrs.fabric,
          neckline: attrs.neckline,
          silhouette: attrs.silhouette,
          sleeve: attrs.sleeve,
          pattern: attrs.pattern,
          occasionJson: JSON.stringify(attrs.occasions),
          attributeVectorJson: JSON.stringify(attrs.attributeVector),
          extractionConfidence: attrs.confidence,
          extractedAt: now,
          rawResponseJson: null,
        })
        .onConflictDoNothing()
        .run();
      extracted += 1;
    }
    const pending = inputs.length - extracted;
    logger.info(`[extract] ${extracted} extracted (${service.mode}), ${pending} pending`);
    return { extracted, pending };
  } catch (e) {
    logger.warn(
      `[extract] extraction service unavailable — ${inputs.length} listings left pending (retried next run): ${e instanceof Error ? e.message : String(e)}`,
    );
    return { extracted: 0, pending: inputs.length };
  }
}
