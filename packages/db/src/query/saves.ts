/**
 * Saves ("My Rack") repository.
 *
 * A save is a `swipe_events` row with verdict='save' — the schema has no
 * dedicated saves table and schema changes are out of bounds this week
 * (docs/decisions-backend-eng.md). Unsave deletes the user's save rows for
 * that listing; like/dislike history is untouched.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { listings, swipeEvents } from '../schema';

const SAVE = 'save';

export function saveListing(
  db: Db,
  userId: string,
  listingId: string,
  context: 'calibration' | 'feed' | 'search' = 'feed',
): boolean {
  const exists = db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.id, listingId))
    .get();
  if (!exists) return false;
  const already = db
    .select({ id: swipeEvents.id })
    .from(swipeEvents)
    .where(
      and(
        eq(swipeEvents.userId, userId),
        eq(swipeEvents.listingId, listingId),
        eq(swipeEvents.verdict, SAVE),
      ),
    )
    .get();
  if (!already) {
    db.insert(swipeEvents)
      .values({ userId, listingId, verdict: SAVE, context, createdAt: Date.now() })
      .run();
  }
  return true;
}

export function unsaveListing(db: Db, userId: string, listingId: string): void {
  db.delete(swipeEvents)
    .where(
      and(
        eq(swipeEvents.userId, userId),
        eq(swipeEvents.listingId, listingId),
        eq(swipeEvents.verdict, SAVE),
      ),
    )
    .run();
}

/** Saved listing ids, most recently saved first (deduped). */
export function savedListingIds(db: Db, userId: string): string[] {
  const rows = db
    .select({ listingId: swipeEvents.listingId, createdAt: swipeEvents.createdAt })
    .from(swipeEvents)
    .where(and(eq(swipeEvents.userId, userId), eq(swipeEvents.verdict, SAVE)))
    .orderBy(desc(swipeEvents.createdAt))
    .all();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.listingId)) {
      seen.add(r.listingId);
      out.push(r.listingId);
    }
  }
  return out;
}

export function isSaved(db: Db, userId: string, listingId: string): boolean {
  return (
    db
      .select({ id: swipeEvents.id })
      .from(swipeEvents)
      .where(
        and(
          eq(swipeEvents.userId, userId),
          eq(swipeEvents.listingId, listingId),
          eq(swipeEvents.verdict, SAVE),
        ),
      )
      .get() != null
  );
}
