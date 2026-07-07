/**
 * Listing repository — candidate queries for feed/search (SQL hard filters,
 * capped newest-first per docs/ARCHITECTURE.md §6), detail hydration, and
 * meta-filter aggregates.
 *
 * Hem-position ("effective length ON HER") is per-user math and cannot be a
 * SQL predicate — callers apply it over the capped candidate set in TS.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Listing } from '@hemline/contracts';
import type { Db } from '../client';
import { extractions, listingImages, listings, sources } from '../schema';
import { parseJson, rowToListing, type ExtractionRow, type ListingRow } from './mappers';

/** Freshness windows (hours) by source kind — spec B1: 24h eBay, 48h Shopify.
 * Fixture corpus spans ~0–72h so the demo kind gets a wider window. */
export const FRESHNESS_HOURS_BY_KIND: Record<string, number> = {
  ebay: 24,
  shopify: 48,
  fixture: 96,
};
export const DEFAULT_FRESHNESS_HOURS = 96;
export const CANDIDATE_CAP = 500;

export interface CandidateQueryOptions {
  sizesNormalized?: number[];
  priceMinCents?: number;
  priceMaxCents?: number;
  conditions?: string[];
  brands?: string[];
  colorFamilies?: string[];
  /** free-text tokens over title/brand/description (LIKE; FTS5 is an upgrade path) */
  query?: string;
  /** restrict to specific sources (search "source" filter) */
  sourceIds?: string[];
  /** garment-label length classes (search filter; distinct from lengthOnBody) */
  lengthClasses?: string[];
  /** single override window; default = per-source-kind windows above */
  freshnessHours?: number;
  excludeListingIds?: string[];
  /** cap, newest-first (default 500) */
  cap?: number;
}

export interface CandidateListing {
  listing: Listing;
  /** sparse tag→weight vector from the extraction (similarity input) */
  attributeVector: Record<string, number>;
  /** source kind ('ebay' | 'shopify' | 'fixture' | …) for freshness half-life */
  sourceKind: string;
}

function sourceKinds(db: Db): Map<string, string> {
  const rows = db.select({ id: sources.id, kind: sources.kind }).from(sources).all();
  return new Map(rows.map((r) => [r.id, r.kind]));
}

/** Build the freshness condition: per-kind window unless an override is given. */
function freshnessCondition(kinds: Map<string, string>, now: number, overrideHours?: number): SQL {
  if (overrideHours != null) {
    return gte(listings.lastSeenAt, now - overrideHours * 3_600_000);
  }
  const groups = new Map<number, string[]>();
  for (const [id, kind] of kinds) {
    const hours = FRESHNESS_HOURS_BY_KIND[kind] ?? DEFAULT_FRESHNESS_HOURS;
    const list = groups.get(hours) ?? [];
    list.push(id);
    groups.set(hours, list);
  }
  if (groups.size === 0) {
    return gte(listings.lastSeenAt, now - DEFAULT_FRESHNESS_HOURS * 3_600_000);
  }
  const parts = [...groups.entries()].map(([hours, ids]) =>
    and(inArray(listings.sourceId, ids), gte(listings.lastSeenAt, now - hours * 3_600_000)),
  ) as SQL[];
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

function inListSql(values: (string | number)[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * SQL hard filters → capped candidate set, newest-first.
 * size ∩ price ∩ condition ∩ brand ∩ color family ∩ source ∩ text query ∩ freshness.
 */
export function queryCandidates(db: Db, opts: CandidateQueryOptions = {}): CandidateListing[] {
  const now = Date.now();
  const kinds = sourceKinds(db);
  const conds: SQL[] = [isNull(listings.removedAt) as SQL, freshnessCondition(kinds, now, opts.freshnessHours)];

  if (opts.sizesNormalized && opts.sizesNormalized.length > 0) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM json_each(${listings.sizeNormalizedJson}) je WHERE je.value IN (${inListSql(opts.sizesNormalized)}))`,
    );
  }
  if (opts.priceMinCents != null) conds.push(gte(listings.priceCents, opts.priceMinCents) as SQL);
  if (opts.priceMaxCents != null) conds.push(lte(listings.priceCents, opts.priceMaxCents) as SQL);
  if (opts.conditions && opts.conditions.length > 0)
    conds.push(inArray(listings.condition, opts.conditions) as SQL);
  if (opts.brands && opts.brands.length > 0) {
    conds.push(
      sql`lower(${listings.brand}) IN (${inListSql(opts.brands.map((b) => b.toLowerCase()))})`,
    );
  }
  if (opts.sourceIds && opts.sourceIds.length > 0)
    conds.push(inArray(listings.sourceId, opts.sourceIds) as SQL);
  if (opts.excludeListingIds && opts.excludeListingIds.length > 0) {
    conds.push(sql`${listings.id} NOT IN (${inListSql(opts.excludeListingIds)})`);
  }
  if (opts.lengthClasses && opts.lengthClasses.length > 0)
    conds.push(inArray(extractions.lengthClass, opts.lengthClasses) as SQL);
  if (opts.colorFamilies && opts.colorFamilies.length > 0) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM json_each(${extractions.colorsJson}) jc WHERE lower(json_extract(jc.value, '$.family')) IN (${inListSql(opts.colorFamilies.map((f) => f.toLowerCase()))}))`,
    );
  }
  if (opts.query && opts.query.trim().length > 0) {
    for (const token of opts.query.trim().toLowerCase().split(/\s+/).slice(0, 8)) {
      const p = `%${token}%`;
      conds.push(
        sql`(lower(${listings.title}) LIKE ${p} OR lower(coalesce(${listings.brand}, '')) LIKE ${p} OR lower(coalesce(${listings.description}, '')) LIKE ${p})`,
      );
    }
  }

  const rows = db
    .select({ listing: listings, extraction: extractions })
    .from(listings)
    .leftJoin(extractions, eq(extractions.listingId, listings.id))
    .where(and(...conds))
    .orderBy(desc(listings.lastSeenAt), asc(listings.id))
    .limit(opts.cap ?? CANDIDATE_CAP)
    .all();

  const imagesByListing = imagesFor(
    db,
    rows.map((r) => r.listing.id),
  );
  return rows.map((r) => toCandidate(r.listing, r.extraction, imagesByListing, kinds));
}

function toCandidate(
  row: ListingRow,
  extraction: ExtractionRow | null,
  imagesByListing: Map<string, string[]>,
  kinds: Map<string, string>,
): CandidateListing {
  return {
    listing: rowToListing(row, extraction, imagesByListing.get(row.id) ?? []),
    attributeVector: extraction
      ? parseJson<Record<string, number>>(extraction.attributeVectorJson, {})
      : {},
    sourceKind: kinds.get(row.sourceId) ?? 'unknown',
  };
}

function imagesFor(db: Db, listingIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (listingIds.length === 0) return map;
  const rows = db
    .select()
    .from(listingImages)
    .where(inArray(listingImages.listingId, listingIds))
    .orderBy(asc(listingImages.position))
    .all();
  for (const r of rows) {
    const arr = map.get(r.listingId) ?? [];
    arr.push(r.url);
    map.set(r.listingId, arr);
  }
  return map;
}

/** Full hydration for the detail page (includes soft-removed listings). */
export function getListingById(db: Db, id: string): CandidateListing | null {
  const row = db
    .select({ listing: listings, extraction: extractions })
    .from(listings)
    .leftJoin(extractions, eq(extractions.listingId, listings.id))
    .where(eq(listings.id, id))
    .get();
  if (!row) return null;
  const kinds = sourceKinds(db);
  return toCandidate(row.listing, row.extraction, imagesFor(db, [id]), kinds);
}

/** Hydrate a set of ids (saves/rack), preserving the input order. */
export function getListingsByIds(db: Db, ids: string[]): CandidateListing[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({ listing: listings, extraction: extractions })
    .from(listings)
    .leftJoin(extractions, eq(extractions.listingId, listings.id))
    .where(inArray(listings.id, ids))
    .all();
  const kinds = sourceKinds(db);
  const imagesByListing = imagesFor(
    db,
    rows.map((r) => r.listing.id),
  );
  const byId = new Map(rows.map((r) => [r.listing.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => toCandidate(r.listing, r.extraction, imagesByListing, kinds));
}

/** GET /api/meta/filters aggregates over active listings. */
export function metaFilters(db: Db): {
  brands: string[];
  colorFamilies: string[];
  priceRange: [number, number];
} {
  const brandRows = db
    .selectDistinct({ brand: listings.brand })
    .from(listings)
    .where(and(isNull(listings.removedAt), sql`${listings.brand} IS NOT NULL`))
    .all();
  const famRows = db.all<{ family: string }>(sql`
    SELECT DISTINCT lower(json_extract(jc.value, '$.family')) AS family
    FROM extractions e
    JOIN listings l ON l.id = e.listing_id AND l.removed_at IS NULL,
    json_each(e.colors_json) jc
    WHERE json_extract(jc.value, '$.family') IS NOT NULL
  `);
  const price = db
    .select({
      min: sql<number | null>`min(${listings.priceCents})`,
      max: sql<number | null>`max(${listings.priceCents})`,
    })
    .from(listings)
    .where(isNull(listings.removedAt))
    .get();
  return {
    brands: brandRows
      .map((r) => r.brand)
      .filter((b): b is string => b != null)
      .sort((a, b) => a.localeCompare(b)),
    colorFamilies: famRows.map((r) => r.family).sort(),
    priceRange: [price?.min ?? 0, price?.max ?? 0],
  };
}
