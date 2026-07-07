/**
 * Swipe repository — records like/dislike/save/skip events and exposes the
 * listing attribute vectors the style-tag learner needs. The learning rule
 * itself lives in the API layer (stub-tolerant vs @hemline/matching).
 */
import { desc, eq, inArray } from 'drizzle-orm';
import type { SwipeEvent } from '@hemline/contracts';
import type { Db } from '../client';
import { extractions, listings, swipeEvents } from '../schema';
import { parseJson } from './mappers';

/** Insert swipe events; silently skips listing ids that do not exist (FK). */
export function recordSwipes(db: Db, userId: string, events: SwipeEvent[]): number {
  if (events.length === 0) return 0;
  const known = new Set(
    db
      .select({ id: listings.id })
      .from(listings)
      .where(inArray(listings.id, events.map((e) => e.listingId)))
      .all()
      .map((r) => r.id),
  );
  const now = Date.now();
  const rows = events
    .filter((e) => known.has(e.listingId))
    .map((e, i) => ({
      userId,
      listingId: e.listingId,
      verdict: e.verdict,
      context: e.context,
      createdAt: now + i, // keep insertion order stable under the same ms
    }));
  if (rows.length > 0) db.insert(swipeEvents).values(rows).run();
  return rows.length;
}

/** attributeVector per listing id (for the swipe → styleTags update). */
export function attributeVectorsFor(
  db: Db,
  listingIds: string[],
): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  if (listingIds.length === 0) return map;
  const rows = db
    .select({ listingId: extractions.listingId, vec: extractions.attributeVectorJson })
    .from(extractions)
    .where(inArray(extractions.listingId, listingIds))
    .all();
  for (const r of rows) map.set(r.listingId, parseJson(r.vec, {}));
  return map;
}

/** Listing ids the user has already swiped (recalibration deck exclusion). */
export function swipedListingIds(db: Db, userId: string): string[] {
  return db
    .selectDistinct({ listingId: swipeEvents.listingId })
    .from(swipeEvents)
    .where(eq(swipeEvents.userId, userId))
    .all()
    .map((r) => r.listingId);
}

/** Most recent swipes first (debug/admin use). */
export function recentSwipes(db: Db, userId: string, limit = 100) {
  return db
    .select()
    .from(swipeEvents)
    .where(eq(swipeEvents.userId, userId))
    .orderBy(desc(swipeEvents.createdAt))
    .limit(limit)
    .all();
}
