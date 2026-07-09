/**
 * Clickout / attribution repository (spec G4; additive 2026-07-08, QA P1 #4).
 *
 * Records outbound affiliate link-outs (revenue attribution + a sold-detection
 * signal) and aggregates counts for the admin ingest-health payload. The
 * destination URL is hashed (sha256) before it touches disk — no full-URL PII.
 */
import { createHash } from 'node:crypto';
import { eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { clickouts, listings } from '../schema';

export function hashDestination(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Record a clickout for a listing. `userId` may be null (guest tolerated).
 * The destination (affiliateUrl ?? sourceUrl) and sourceId are derived
 * server-side from the listing row so the client cannot spoof attribution.
 * Returns false when the listing does not exist.
 */
export function recordClickout(db: Db, listingId: string, userId: string | null): boolean {
  const row = db
    .select({
      id: listings.id,
      sourceId: listings.sourceId,
      affiliateUrl: listings.affiliateUrl,
      sourceUrl: listings.sourceUrl,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .get();
  if (!row) return false;
  db.insert(clickouts)
    .values({
      listingId: row.id,
      userId,
      sourceId: row.sourceId,
      destinationHash: hashDestination(row.affiliateUrl ?? row.sourceUrl),
      clickedAt: Date.now(),
    })
    .run();
  return true;
}

export interface ClickoutStats {
  total: number;
  last24h: number;
  /** sourceId → all-time clickout count */
  bySource: Record<string, number>;
}

/** Aggregates for GET /api/admin/ingest (additive `clickouts` field). */
export function clickoutStats(db: Db, now = Date.now()): ClickoutStats {
  const total =
    db.select({ n: sql<number>`count(*)` }).from(clickouts).get()?.n ?? 0;
  const last24h =
    db
      .select({ n: sql<number>`count(*)` })
      .from(clickouts)
      .where(gte(clickouts.clickedAt, now - 24 * 3_600_000))
      .get()?.n ?? 0;
  const rows = db
    .select({ sourceId: clickouts.sourceId, n: sql<number>`count(*)` })
    .from(clickouts)
    .groupBy(clickouts.sourceId)
    .all();
  return {
    total,
    last24h,
    bySource: Object.fromEntries(rows.map((r) => [r.sourceId, r.n])),
  };
}
