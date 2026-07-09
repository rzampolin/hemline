/**
 * Sold/dead-listing verification repository (additive, 2026-07-09 data-eng).
 *
 * Between daily crawls a sold dress stays fully visible; clickouts give us a
 * cheap interest signal to prioritize re-checks. This module owns:
 * - the verification_queue (clickout → enqueue; scheduler drains ~15-min)
 * - rolling batch selection (oldest-verified active listings first)
 * - the state transitions the worker applies:
 *     verified gone/sold  → removed_at = now  (existing soft-delete semantics
 *                           — feed/search already exclude removed listings)
 *     size sold out       → availability_json + size_normalized_json updated
 *                           from IN-STOCK labels only (sizes are the feed's
 *                           hard filter; raw size_labels_json stays as-seen
 *                           because it feeds content_hash)
 *     verified fine       → verified_at = now
 *   Transient errors apply NO transition (timeout ≠ sold).
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { listings, verificationQueue } from '../schema';
import { normalizeSizeLabels } from '../size-normalize';
import { parseJson } from './mappers';

/** Source kinds the worker can re-check cheaply (pure HTTP, no credentials). */
const VERIFIABLE_SOURCE_PREFIXES = ['shopify:', 'jsonld:'] as const;

export function isVerifiableSource(sourceId: string): boolean {
  return VERIFIABLE_SOURCE_PREFIXES.some((p) => sourceId.startsWith(p));
}

function verifiableSourceCondition() {
  return or(
    ...VERIFIABLE_SOURCE_PREFIXES.map((p) => sql`${listings.sourceId} LIKE ${`${p}%`}`),
  );
}

/**
 * Enqueue a listing for availability verification (clickout hook). No-op for
 * unknown ids, already-removed listings, unverifiable source kinds (eBay needs
 * API auth; fixtures have no live source), and already-queued listings (PK
 * dedupe keeps the earliest pending entry). Returns true when a row was added.
 */
export function enqueueVerification(
  db: Db,
  listingId: string,
  reason: 'clickout' | 'manual',
  now = Date.now(),
): boolean {
  const row = db
    .select({ sourceId: listings.sourceId, removedAt: listings.removedAt })
    .from(listings)
    .where(eq(listings.id, listingId))
    .get();
  if (!row || row.removedAt != null || !isVerifiableSource(row.sourceId)) return false;
  const res = db
    .insert(verificationQueue)
    .values({ listingId, reason, enqueuedAt: now })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export interface QueuedVerification {
  listingId: string;
  reason: string;
  enqueuedAt: number;
}

/** Oldest pending queue entries (does not delete — call dequeue after the attempt). */
export function peekVerificationQueue(db: Db, limit: number): QueuedVerification[] {
  if (limit <= 0) return [];
  return db
    .select()
    .from(verificationQueue)
    .orderBy(asc(verificationQueue.enqueuedAt), asc(verificationQueue.listingId))
    .limit(limit)
    .all();
}

/** Remove processed entries (any outcome — inconclusive retries ride the rolling batch). */
export function dequeueVerification(db: Db, listingIds: string[]): void {
  if (listingIds.length === 0) return;
  db.delete(verificationQueue).where(inArray(verificationQueue.listingId, listingIds)).run();
}

export function verificationQueueSize(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(verificationQueue).get()?.n ?? 0;
}

/**
 * Rolling catalog sweep: the N active (non-removed) listings of verifiable
 * sources whose last conclusive check is oldest (never-verified first, oldest
 * crawl sighting breaking ties) — so the whole catalog cycles through
 * verification even without clicks.
 */
export function selectOldestVerifiedActive(db: Db, limit: number): string[] {
  if (limit <= 0) return [];
  return db
    .select({ id: listings.id })
    .from(listings)
    .where(and(isNull(listings.removedAt), verifiableSourceCondition()))
    .orderBy(
      asc(sql`COALESCE(${listings.verifiedAt}, 0)`),
      asc(listings.lastSeenAt),
      asc(listings.id),
    )
    .limit(limit)
    .all()
    .map((r) => r.id);
}

export interface VerifiableListing {
  id: string;
  sourceId: string;
  sourceUrl: string;
  sizeLabels: string[];
  availability: Record<string, boolean>;
  removedAt: number | null;
}

/** Hydrate the fields the verification worker needs, preserving input order. */
export function getVerifiableListings(db: Db, ids: string[]): VerifiableListing[] {
  if (ids.length === 0) return [];
  const rows = db
    .select({
      id: listings.id,
      sourceId: listings.sourceId,
      sourceUrl: listings.sourceUrl,
      sizeLabelsJson: listings.sizeLabelsJson,
      availabilityJson: listings.availabilityJson,
      removedAt: listings.removedAt,
    })
    .from(listings)
    .where(inArray(listings.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      sourceUrl: r.sourceUrl,
      sizeLabels: parseJson<string[]>(r.sizeLabelsJson, []),
      availability: parseJson<Record<string, boolean>>(r.availabilityJson, {}),
      removedAt: r.removedAt,
    }));
}

/** Verified sold/gone → soft delete (same semantics as pruneStale / explicit removals). */
export function markListingGone(db: Db, listingId: string, now = Date.now()): void {
  db.update(listings)
    .set({ removedAt: now, verifiedAt: now })
    .where(eq(listings.id, listingId))
    .run();
}

/** Verified fine (or page alive with no per-size signal) → bump verified_at only. */
export function markListingVerified(db: Db, listingId: string, now = Date.now()): void {
  db.update(listings).set({ verifiedAt: now }).where(eq(listings.id, listingId)).run();
}

/**
 * Verified per-size availability → write the fresh map and re-derive
 * size_normalized_json from the IN-STOCK labels only, so the feed's size hard
 * filter stops matching sold-out sizes. Raw size_labels_json is intentionally
 * untouched (it feeds content_hash — rewriting it would churn the extraction/
 * embedding caches). Availability is not hashed (decisions-data-eng #9), so
 * the next crawl reconciles cleanly.
 */
export function applyVerifiedAvailability(
  db: Db,
  listingId: string,
  availability: Record<string, boolean>,
  now = Date.now(),
): { inStockLabels: string[] } {
  const inStockLabels = Object.keys(availability).filter((k) => availability[k]);
  db.update(listings)
    .set({
      availabilityJson: JSON.stringify(availability),
      sizeNormalizedJson: JSON.stringify(normalizeSizeLabels(inStockLabels)),
      verifiedAt: now,
    })
    .where(eq(listings.id, listingId))
    .run();
  return { inStockLabels };
}
