/**
 * Pending alerts (spec F4 — stub only, NO email sending).
 *
 * The core schema (ARCHITECTURE §3) has no `pending_alerts` table and schema
 * changes are frozen this week, so this repo materializes an auxiliary table
 * lazily via CREATE TABLE IF NOT EXISTS. Flagged as a schema-change request
 * in docs/decisions-backend-eng.md so it graduates into schema.ts +
 * drizzle-kit at the next 4-party review.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../client';

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

let ensured = new WeakSet<object>();

export function ensureAlertTable(db: Db): void {
  if (ensured.has(db as object)) return;
  db.run(
    sql.raw(`CREATE TABLE IF NOT EXISTS pending_alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      listing_id  TEXT,
      search_json TEXT,
      kind        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE (user_id, listing_id, kind)
    )`),
  );
  ensured.add(db as object);
}

/** Upsert the toggle for (user, listing, kind). Returns the stored row. */
export function toggleAlert(
  db: Db,
  userId: string,
  opts: { listingId?: string | null; searchJson?: string | null; kind: AlertKind; enabled: boolean },
): PendingAlert {
  ensureAlertTable(db);
  const now = Date.now();
  db.run(sql`
    INSERT INTO pending_alerts (user_id, listing_id, search_json, kind, enabled, created_at, updated_at)
    VALUES (${userId}, ${opts.listingId ?? null}, ${opts.searchJson ?? null}, ${opts.kind}, ${opts.enabled ? 1 : 0}, ${now}, ${now})
    ON CONFLICT (user_id, listing_id, kind)
    DO UPDATE SET enabled = ${opts.enabled ? 1 : 0}, search_json = coalesce(${opts.searchJson ?? null}, search_json), updated_at = ${now}
  `);
  const row = db.get<{
    id: number;
    user_id: string;
    listing_id: string | null;
    search_json: string | null;
    kind: AlertKind;
    enabled: number;
    created_at: number;
    updated_at: number;
  }>(sql`
    SELECT * FROM pending_alerts
    WHERE user_id = ${userId} AND listing_id IS ${opts.listingId ?? null} AND kind = ${opts.kind}
  `);
  if (!row) throw new Error('alert upsert failed');
  return mapRow(row);
}

export function listAlerts(db: Db, userId: string): PendingAlert[] {
  ensureAlertTable(db);
  const rows = db.all<{
    id: number;
    user_id: string;
    listing_id: string | null;
    search_json: string | null;
    kind: AlertKind;
    enabled: number;
    created_at: number;
    updated_at: number;
  }>(sql`SELECT * FROM pending_alerts WHERE user_id = ${userId} ORDER BY created_at DESC`);
  return rows.map(mapRow);
}

function mapRow(r: {
  id: number;
  user_id: string;
  listing_id: string | null;
  search_json: string | null;
  kind: AlertKind;
  enabled: number;
  created_at: number;
  updated_at: number;
}): PendingAlert {
  return {
    id: r.id,
    userId: r.user_id,
    listingId: r.listing_id,
    searchJson: r.search_json,
    kind: r.kind,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** test hook */
export function __resetAlertTableCache(): void {
  ensured = new WeakSet<object>();
}
