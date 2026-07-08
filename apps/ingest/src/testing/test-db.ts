/**
 * Test-only: temp-file SQLite with the ingestion subset of the schema
 * (docs/ARCHITECTURE.md §3), typed as the real @hemline/db client.
 * drizzle-kit isn't available at test time, so the DDL lives here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@hemline/db';

const DDL = [
  `CREATE TABLE sources (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    cadence_cron  TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   INTEGER,
    etag_json     TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE ingest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     TEXT NOT NULL REFERENCES sources(id),
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    status        TEXT NOT NULL DEFAULT 'running',
    stats_json    TEXT NOT NULL DEFAULT '{}',
    error         TEXT
  )`,
  `CREATE TABLE listings (
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
  `CREATE INDEX idx_listings_last_seen ON listings(last_seen_at)`,
  `CREATE TABLE listing_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE extractions (
    content_hash        TEXT PRIMARY KEY,
    listing_id          TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    model               TEXT NOT NULL,
    length_class        TEXT,
    length_inches       REAL,
    length_basis        TEXT,
    length_anchor       TEXT,
    length_anchor_height_in REAL,
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
  `CREATE TABLE listing_embeddings (
    content_hash TEXT NOT NULL,
    model        TEXT NOT NULL,
    listing_id   TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    dim          INTEGER NOT NULL,
    vector       BLOB NOT NULL,
    image_url    TEXT,
    embedded_at  INTEGER NOT NULL,
    PRIMARY KEY (content_hash, model)
  )`,
];

export function createTestDb(): { db: Db; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-ingest-test-'));
  const db = createDb({ dbPath: path.join(dir, 'test.db') });
  for (const ddl of DDL) db.run(sql.raw(ddl));
  return {
    db,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
