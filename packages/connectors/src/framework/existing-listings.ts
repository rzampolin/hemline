/**
 * Re-emit a source's previously-crawled listings as RawListings.
 *
 * Used by the Shopify connector when the catalog responds `304 Not Modified`:
 * the crawl short-circuits but the connector still returns the (unchanged)
 * listings so the pipeline bumps `last_seen_at` — otherwise an unchanged store
 * would look stale and get pruned. Raw SQL for the same cycle-avoidance reason
 * as etag-cache.ts.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Condition, RawListing } from '@hemline/contracts';

interface SqlAll {
  all(query: SQL): unknown;
}

interface ListingRow {
  sourceListingId: string;
  sourceUrl: string;
  affiliateUrl: string | null;
  title: string;
  description: string | null;
  brand: string | null;
  priceCents: number;
  currency: string;
  condition: string;
  isVintage: number;
  era: string | null;
  sizeLabelsJson: string;
  availabilityJson: string;
  imageUrls: string | null;
}

export function loadExistingRawListings(
  db: unknown,
  sourceId: string,
  seenAt: number,
): RawListing[] {
  const d = db as SqlAll;
  const rows = d.all(sql`
    SELECT
      l.source_listing_id AS sourceListingId,
      l.source_url        AS sourceUrl,
      l.affiliate_url     AS affiliateUrl,
      l.title             AS title,
      l.description       AS description,
      l.brand             AS brand,
      l.price_cents       AS priceCents,
      l.currency          AS currency,
      l.condition         AS condition,
      l.is_vintage        AS isVintage,
      l.era               AS era,
      l.size_labels_json  AS sizeLabelsJson,
      l.availability_json AS availabilityJson,
      (
        SELECT group_concat(i.url, char(31))
        FROM (
          SELECT url FROM listing_images
          WHERE listing_id = l.id ORDER BY position
        ) AS i
      ) AS imageUrls
    FROM listings l
    WHERE l.source_id = ${sourceId} AND l.removed_at IS NULL
  `) as ListingRow[];

  return rows.map((r) => ({
    sourceId,
    sourceListingId: r.sourceListingId,
    sourceUrl: r.sourceUrl,
    ...(r.affiliateUrl ? { affiliateUrl: r.affiliateUrl } : {}),
    title: r.title,
    ...(r.description != null ? { description: r.description } : {}),
    ...(r.brand != null ? { brand: r.brand } : {}),
    priceCents: r.priceCents,
    currency: r.currency,
    imageUrls: r.imageUrls ? r.imageUrls.split('\x1f') : [],
    sizeLabels: JSON.parse(r.sizeLabelsJson) as string[],
    availability: JSON.parse(r.availabilityJson) as Record<string, boolean>,
    condition: r.condition as Condition,
    isVintage: Boolean(r.isVintage),
    ...(r.era != null ? { era: r.era } : {}),
    seenAt,
  }));
}
