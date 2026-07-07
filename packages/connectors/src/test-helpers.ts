/**
 * Test-only helpers (not exported from the package root).
 * In-memory SQLite with the ingestion subset of the schema (docs/ARCHITECTURE.md §3)
 * so framework/db-touching code can be tested without drizzle-kit.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export const INGESTION_DDL = [
  `CREATE TABLE IF NOT EXISTS sources (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    cadence_cron  TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   INTEGER,
    etag_json     TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     TEXT NOT NULL REFERENCES sources(id),
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    status        TEXT NOT NULL DEFAULT 'running',
    stats_json    TEXT NOT NULL DEFAULT '{}',
    error         TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS listings (
    id                 TEXT PRIMARY KEY,
    source_id          TEXT NOT NULL REFERENCES sources(id),
    source_listing_id  TEXT NOT NULL,
    source_url         TEXT NOT NULL,
    affiliate_url      TEXT,
    title              TEXT NOT NULL,
    description        TEXT,
    brand              TEXT,
    price_cents        INTEGER NOT NULL,
    currency           TEXT NOT NULL DEFAULT 'USD',
    condition          TEXT NOT NULL DEFAULT 'unknown',
    is_vintage         INTEGER NOT NULL DEFAULT 0,
    era                TEXT,
    size_labels_json   TEXT NOT NULL DEFAULT '[]',
    size_normalized_json TEXT NOT NULL DEFAULT '[]',
    availability_json  TEXT NOT NULL DEFAULT '{}',
    content_hash       TEXT NOT NULL,
    first_seen_at      INTEGER NOT NULL,
    last_seen_at       INTEGER NOT NULL,
    removed_at         INTEGER,
    UNIQUE (source_id, source_listing_id)
  )`,
  `CREATE TABLE IF NOT EXISTS listing_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS extractions (
    content_hash        TEXT PRIMARY KEY,
    listing_id          TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    model               TEXT NOT NULL,
    length_class        TEXT,
    length_inches       REAL,
    measurements_json   TEXT NOT NULL DEFAULT '{}',
    colors_json         TEXT NOT NULL DEFAULT '[]',
    fabric              TEXT,
    neckline            TEXT,
    silhouette          TEXT,
    sleeve              TEXT,
    pattern             TEXT,
    occasion_json       TEXT NOT NULL DEFAULT '[]',
    attribute_vector_json TEXT NOT NULL DEFAULT '{}',
    extraction_confidence REAL NOT NULL DEFAULT 0,
    extracted_at        INTEGER NOT NULL,
    raw_response_json   TEXT
  )`,
];

export function createIngestionTestDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const ddl of INGESTION_DDL) sqlite.exec(ddl);
  return drizzle(sqlite);
}
