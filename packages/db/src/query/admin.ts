/**
 * Admin repository — ingestion health (spec G1) + extraction QA (spec G2).
 *
 * Manual corrections update the `extractions` row in place, stamp
 * model='manual' (so re-ingest can skip overwriting — integration note for
 * data-eng), and append to an auxiliary `extraction_corrections` log table
 * (created lazily; flagged as a schema-change request like pending_alerts).
 */
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  extractionCorrections,
  extractions,
  ingestRuns,
  listingEmbeddings,
  listingImages,
  listings,
  sources,
} from '../schema';

// ── G1: ingestion health ────────────────────────────────────────────────

export interface SourceHealth {
  id: string;
  kind: string;
  displayName: string;
  enabled: boolean;
  cadenceCron: string;
  lastRunAt: number | null;
  lastRun: {
    id: number;
    startedAt: number;
    finishedAt: number | null;
    status: string;
    stats: Record<string, unknown>;
    error: string | null;
  } | null;
  errorRunCount: number;
  listingCounts: {
    total: number;
    active: number;
    removed: number;
    fresh24h: number;
    fresh48h: number;
    staleOver48h: number;
  };
}

export function ingestionHealth(db: Db): SourceHealth[] {
  const now = Date.now();
  const srcRows = db.select().from(sources).all();
  return srcRows.map((s) => {
    const lastRun = db
      .select()
      .from(ingestRuns)
      .where(eq(ingestRuns.sourceId, s.id))
      .orderBy(desc(ingestRuns.startedAt))
      .limit(1)
      .get();
    const errorRuns = db
      .select({ n: sql<number>`count(*)` })
      .from(ingestRuns)
      .where(and(eq(ingestRuns.sourceId, s.id), eq(ingestRuns.status, 'error')))
      .get();
    const count = (where?: ReturnType<typeof and>) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(listings)
        .where(where ? and(eq(listings.sourceId, s.id), where) : eq(listings.sourceId, s.id))
        .get()?.n ?? 0;
    const total = count();
    const active = count(and(isNull(listings.removedAt)));
    const fresh24h = count(and(isNull(listings.removedAt), gte(listings.lastSeenAt, now - 24 * 3_600_000)));
    const fresh48h = count(and(isNull(listings.removedAt), gte(listings.lastSeenAt, now - 48 * 3_600_000)));
    const staleOver48h = count(and(isNull(listings.removedAt), lte(listings.lastSeenAt, now - 48 * 3_600_000)));
    let stats: Record<string, unknown> = {};
    try {
      stats = lastRun ? (JSON.parse(lastRun.statsJson) as Record<string, unknown>) : {};
    } catch {
      /* keep {} */
    }
    return {
      id: s.id,
      kind: s.kind,
      displayName: s.displayName,
      enabled: s.enabled,
      cadenceCron: s.cadenceCron,
      lastRunAt: s.lastRunAt ?? null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt ?? null,
            status: lastRun.status,
            stats,
            error: lastRun.error ?? null,
          }
        : null,
      errorRunCount: errorRuns?.n ?? 0,
      listingCounts: { total, active, removed: total - active, fresh24h, fresh48h, staleOver48h },
    };
  });
}

/** Record an ingest run row (the trigger endpoint logs its outcome here). */
export function insertIngestRun(
  db: Db,
  run: {
    sourceId: string;
    startedAt: number;
    finishedAt?: number | null;
    status: string;
    stats?: Record<string, unknown>;
    error?: string | null;
  },
): number {
  const res = db
    .insert(ingestRuns)
    .values({
      sourceId: run.sourceId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      status: run.status,
      statsJson: JSON.stringify(run.stats ?? {}),
      error: run.error ?? null,
    })
    .run();
  return Number(res.lastInsertRowid);
}

export function listSourceIds(db: Db, onlyEnabled = true): string[] {
  const rows = onlyEnabled
    ? db.select({ id: sources.id }).from(sources).where(eq(sources.enabled, true)).all()
    : db.select({ id: sources.id }).from(sources).all();
  return rows.map((r) => r.id);
}

// ── Catalog overview (admin dashboard header, additive 2026-07-09) ──────

export interface CatalogOverview {
  listings: { total: number; active: number };
  /** embedding rows / distinct active listings with at least one vector */
  vectors: { rows: number; embeddedListings: number };
  /**
   * Extraction coverage over ACTIVE listings (the denominator founders care
   * about): how much of the live catalog has each attribute filled in.
   * Percentages are 0–100, rounded to one decimal.
   */
  extraction: {
    extractedListings: number;
    lengthClassPct: number;
    lengthInchesPct: number;
    colorsPct: number;
  };
}

/** Read-only aggregate for the admin dashboard header. Cheap count queries. */
export function catalogOverview(db: Db): CatalogOverview {
  const n = (row: { n: number } | undefined) => row?.n ?? 0;
  const total = n(db.select({ n: sql<number>`count(*)` }).from(listings).get());
  const active = n(
    db.select({ n: sql<number>`count(*)` }).from(listings).where(isNull(listings.removedAt)).get(),
  );
  const vectorRows = n(db.select({ n: sql<number>`count(*)` }).from(listingEmbeddings).get());
  const embeddedListings = n(
    db
      .select({ n: sql<number>`count(distinct ${listingEmbeddings.listingId})` })
      .from(listingEmbeddings)
      .innerJoin(listings, eq(listings.id, listingEmbeddings.listingId))
      .where(isNull(listings.removedAt))
      .get(),
  );
  // one pass over active-listing extractions for all coverage counters
  const cov = db
    .select({
      extracted: sql<number>`count(distinct ${extractions.listingId})`,
      withLengthClass: sql<number>`count(distinct case when ${extractions.lengthClass} is not null then ${extractions.listingId} end)`,
      withLengthInches: sql<number>`count(distinct case when ${extractions.lengthInches} is not null then ${extractions.listingId} end)`,
      withColors: sql<number>`count(distinct case when ${extractions.colorsJson} not in ('[]', '') then ${extractions.listingId} end)`,
    })
    .from(extractions)
    .innerJoin(listings, eq(listings.id, extractions.listingId))
    .where(isNull(listings.removedAt))
    .get();
  const pct = (x: number) => (active > 0 ? Math.round((x / active) * 1000) / 10 : 0);
  return {
    listings: { total, active },
    vectors: { rows: vectorRows, embeddedListings },
    extraction: {
      extractedListings: cov?.extracted ?? 0,
      lengthClassPct: pct(cov?.withLengthClass ?? 0),
      lengthInchesPct: pct(cov?.withLengthInches ?? 0),
      colorsPct: pct(cov?.withColors ?? 0),
    },
  };
}

// ── G2: extraction QA ───────────────────────────────────────────────────

export interface ExtractionQaRow {
  contentHash: string;
  listingId: string;
  listingTitle: string;
  sourceId: string;
  sourceUrl: string;
  model: string;
  lengthClass: string | null;
  lengthInches: number | null;
  measurements: Record<string, unknown>;
  colors: unknown[];
  fabric: string | null;
  neckline: string | null;
  silhouette: string | null;
  sleeve: string | null;
  pattern: string | null;
  occasions: unknown[];
  confidence: number;
  extractedAt: number;
  /** raw source text for side-by-side QA */
  rawTitle: string;
  rawDescription: string | null;
  /** first listing image (additive 2026-07-09, admin dashboard thumbnails) */
  imageUrl: string | null;
}

/** Correlated subquery: first image url for the joined listing row. */
const firstImageUrl = sql<string | null>`(
  select ${listingImages.url} from ${listingImages}
  where ${listingImages.listingId} = ${listings.id}
  order by ${listingImages.position} asc limit 1
)`;

export interface ExtractionQaQuery {
  maxConfidence?: number;
  missingLength?: boolean;
  limit?: number;
  offset?: number;
}

export function listExtractionsForQa(db: Db, q: ExtractionQaQuery = {}): {
  items: ExtractionQaRow[];
  total: number;
} {
  const conds = [] as ReturnType<typeof gte>[];
  if (q.maxConfidence != null)
    conds.push(lte(extractions.extractionConfidence, q.maxConfidence));
  if (q.missingLength) {
    conds.push(isNull(extractions.lengthInches));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(extractions)
      .where(where)
      .get()?.n ?? 0;
  const rows = db
    .select({ e: extractions, l: listings, imageUrl: firstImageUrl })
    .from(extractions)
    .innerJoin(listings, eq(listings.id, extractions.listingId))
    .where(where)
    .orderBy(extractions.extractionConfidence, desc(extractions.extractedAt))
    .limit(q.limit ?? 50)
    .offset(q.offset ?? 0)
    .all();
  const parse = (t: string, fb: unknown) => {
    try {
      return JSON.parse(t);
    } catch {
      return fb;
    }
  };
  return {
    total,
    items: rows.map(({ e, l, imageUrl }) => ({
      contentHash: e.contentHash,
      listingId: e.listingId,
      listingTitle: l.title,
      sourceId: l.sourceId,
      sourceUrl: l.sourceUrl,
      model: e.model,
      lengthClass: e.lengthClass ?? null,
      lengthInches: e.lengthInches ?? null,
      measurements: parse(e.measurementsJson, {}) as Record<string, unknown>,
      colors: parse(e.colorsJson, []) as unknown[],
      fabric: e.fabric ?? null,
      neckline: e.neckline ?? null,
      silhouette: e.silhouette ?? null,
      sleeve: e.sleeve ?? null,
      pattern: e.pattern ?? null,
      occasions: parse(e.occasionJson, []) as unknown[],
      confidence: e.extractionConfidence,
      extractedAt: e.extractedAt,
      rawTitle: l.title,
      rawDescription: l.description ?? null,
      imageUrl: imageUrl ?? null,
    })),
  };
}

export interface ExtractionCorrection {
  lengthClass?: string | null;
  lengthInches?: number | null;
  measurements?: { bust?: number | null; waist?: number | null; hip?: number | null; length?: number | null };
  colors?: { name: string; family: string; hex: string | null }[];
  fabric?: string | null;
  neckline?: string | null;
  silhouette?: string | null;
  sleeve?: string | null;
  pattern?: string | null;
  occasions?: string[];
  confidence?: number;
}

/**
 * Apply a manual correction (spec G2): update the extraction in place, stamp
 * model='manual' (re-ingest skips these — see apps/ingest extraction.ts), keep
 * a correction log row for prompt-tuning. `extraction_corrections` is a real
 * schema table since integration (2026-07-06).
 */
export function applyExtractionCorrection(
  db: Db,
  contentHash: string,
  patch: ExtractionCorrection,
): ExtractionQaRow | null {
  const existing = db
    .select()
    .from(extractions)
    .where(eq(extractions.contentHash, contentHash))
    .get();
  if (!existing) return null;

  const set: Partial<typeof extractions.$inferInsert> = { model: 'manual' };
  if (patch.lengthClass !== undefined) set.lengthClass = patch.lengthClass;
  if (patch.lengthInches !== undefined) set.lengthInches = patch.lengthInches;
  if (patch.measurements !== undefined) {
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(existing.measurementsJson) as Record<string, unknown>;
    } catch {
      /* keep {} */
    }
    set.measurementsJson = JSON.stringify({ ...prev, ...patch.measurements });
  }
  if (patch.colors !== undefined) set.colorsJson = JSON.stringify(patch.colors);
  if (patch.fabric !== undefined) set.fabric = patch.fabric;
  if (patch.neckline !== undefined) set.neckline = patch.neckline;
  if (patch.silhouette !== undefined) set.silhouette = patch.silhouette;
  if (patch.sleeve !== undefined) set.sleeve = patch.sleeve;
  if (patch.pattern !== undefined) set.pattern = patch.pattern;
  if (patch.occasions !== undefined) set.occasionJson = JSON.stringify(patch.occasions);
  if (patch.confidence !== undefined) set.extractionConfidence = patch.confidence;

  db.update(extractions).set(set).where(eq(extractions.contentHash, contentHash)).run();
  db.insert(extractionCorrections)
    .values({
      contentHash,
      listingId: existing.listingId,
      patchJson: JSON.stringify(patch),
      previousJson: JSON.stringify(existing),
      correctedAt: Date.now(),
    })
    .run();

  return getExtractionQaRow(db, contentHash);
}

export function getExtractionQaRow(db: Db, contentHash: string): ExtractionQaRow | null {
  const row = db
    .select({ e: extractions, l: listings, imageUrl: firstImageUrl })
    .from(extractions)
    .innerJoin(listings, eq(listings.id, extractions.listingId))
    .where(eq(extractions.contentHash, contentHash))
    .get();
  if (!row) return null;
  const parse = (t: string, fb: unknown) => {
    try {
      return JSON.parse(t);
    } catch {
      return fb;
    }
  };
  const { e, l } = row;
  return {
    contentHash: e.contentHash,
    listingId: e.listingId,
    listingTitle: l.title,
    sourceId: l.sourceId,
    sourceUrl: l.sourceUrl,
    model: e.model,
    lengthClass: e.lengthClass ?? null,
    lengthInches: e.lengthInches ?? null,
    measurements: parse(e.measurementsJson, {}) as Record<string, unknown>,
    colors: parse(e.colorsJson, []) as unknown[],
    fabric: e.fabric ?? null,
    neckline: e.neckline ?? null,
    silhouette: e.silhouette ?? null,
    sleeve: e.sleeve ?? null,
    pattern: e.pattern ?? null,
    occasions: parse(e.occasionJson, []) as unknown[],
    confidence: e.extractionConfidence,
    extractedAt: e.extractedAt,
    rawTitle: l.title,
    rawDescription: l.description ?? null,
    imageUrl: row.imageUrl ?? null,
  };
}
