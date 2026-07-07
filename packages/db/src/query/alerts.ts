/**
 * Pending alerts (spec F4 — stub only, NO email sending).
 *
 * `pending_alerts` was adopted into schema.ts + ddl.ts at integration
 * (2026-07-06); the lazy CREATE TABLE from the schema-freeze week is gone.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { pendingAlerts } from '../schema';

export type AlertKind = 'price_drop' | 'low_stock' | 'new_matches';

export interface PendingAlert {
  id: number;
  userId: string;
  listingId: string | null;
  searchJson: string | null;
  kind: AlertKind;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Upsert the toggle for (user, listing, kind). Returns the stored row. */
export function toggleAlert(
  db: Db,
  userId: string,
  opts: { listingId?: string | null; searchJson?: string | null; kind: AlertKind; enabled: boolean },
): PendingAlert {
  const now = Date.now();
  const listingId = opts.listingId ?? null;
  // Raw upsert: SQLite UNIQUE treats NULL listing_id as distinct, matching the
  // pre-adoption behavior for search-level alerts.
  db.run(sql`
    INSERT INTO pending_alerts (user_id, listing_id, search_json, kind, enabled, created_at, updated_at)
    VALUES (${userId}, ${listingId}, ${opts.searchJson ?? null}, ${opts.kind}, ${opts.enabled ? 1 : 0}, ${now}, ${now})
    ON CONFLICT (user_id, listing_id, kind)
    DO UPDATE SET enabled = ${opts.enabled ? 1 : 0}, search_json = coalesce(${opts.searchJson ?? null}, search_json), updated_at = ${now}
  `);
  const row = db
    .select()
    .from(pendingAlerts)
    .where(
      and(
        eq(pendingAlerts.userId, userId),
        listingId === null ? sql`${pendingAlerts.listingId} IS NULL` : eq(pendingAlerts.listingId, listingId),
        eq(pendingAlerts.kind, opts.kind),
      ),
    )
    .orderBy(desc(pendingAlerts.updatedAt))
    .get();
  if (!row) throw new Error('alert upsert failed');
  return mapRow(row);
}

export function listAlerts(db: Db, userId: string): PendingAlert[] {
  return db
    .select()
    .from(pendingAlerts)
    .where(eq(pendingAlerts.userId, userId))
    .orderBy(desc(pendingAlerts.createdAt))
    .all()
    .map(mapRow);
}

function mapRow(r: typeof pendingAlerts.$inferSelect): PendingAlert {
  return {
    id: r.id,
    userId: r.userId,
    listingId: r.listingId ?? null,
    searchJson: r.searchJson ?? null,
    kind: r.kind as AlertKind,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
