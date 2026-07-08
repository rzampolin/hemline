/**
 * Programmatic schema bootstrap — the exact DDL from docs/ARCHITECTURE.md §3,
 * as CREATE TABLE IF NOT EXISTS statements.
 *
 * Dev flow still uses `npm run db:migrate` (drizzle-kit push); this exists so
 * tests (and any embedded consumer) can materialize the schema on a temp
 * SQLite file without shelling out to drizzle-kit. Keep in lockstep with
 * `schema.ts` — additive changes only.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';

const STATEMENTS = [
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
  `CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_brand ON listings(brand)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price_cents)`,
  `CREATE TABLE IF NOT EXISTS listing_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_images_listing ON listing_images(listing_id)`,
  `CREATE TABLE IF NOT EXISTS extractions (
    content_hash        TEXT PRIMARY KEY,
    listing_id          TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    model               TEXT NOT NULL,
    length_class        TEXT,
    length_inches       REAL,
    length_basis        TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_extractions_listing ON extractions(listing_id)`,
  `CREATE TABLE IF NOT EXISTS listing_embeddings (
    content_hash TEXT NOT NULL,
    model        TEXT NOT NULL,
    listing_id   TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    dim          INTEGER NOT NULL,
    vector       BLOB NOT NULL,
    image_url    TEXT,
    embedded_at  INTEGER NOT NULL,
    PRIMARY KEY (content_hash, model)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_listing ON listing_embeddings(listing_id)`,
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    height_inches REAL,
    heel_pref_inches REAL NOT NULL DEFAULT 0,
    sizes_json    TEXT NOT NULL DEFAULT '[]',
    measurements_json TEXT NOT NULL DEFAULT '{}',
    length_prefs_json TEXT NOT NULL DEFAULT '[]',
    coverage_prefs_json TEXT NOT NULL DEFAULT '{}',
    budget_min_cents INTEGER,
    budget_max_cents INTEGER,
    color_season  TEXT,
    palette_json  TEXT NOT NULL DEFAULT '[]',
    style_tags_json TEXT NOT NULL DEFAULT '{}',
    onboarded_at  INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS user_brand_sizes (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand     TEXT NOT NULL,
    size_label TEXT NOT NULL,
    PRIMARY KEY (user_id, brand)
  )`,
  `CREATE TABLE IF NOT EXISTS swipe_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id  TEXT NOT NULL REFERENCES listings(id),
    verdict     TEXT NOT NULL,
    context     TEXT NOT NULL DEFAULT 'feed',
    created_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swipes_user ON swipe_events(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS rerank_cache (
    cache_key    TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    model        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pending_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    listing_id  TEXT,
    search_json TEXT,
    kind        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (user_id, listing_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS extraction_corrections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash  TEXT NOT NULL,
    listing_id    TEXT NOT NULL,
    patch_json    TEXT NOT NULL,
    previous_json TEXT NOT NULL,
    corrected_at  INTEGER NOT NULL
  )`,
];

/**
 * Additive column migrations for databases created before the column existed
 * (CREATE TABLE IF NOT EXISTS won't alter an existing table). Guarded by a
 * PRAGMA table_info check so re-runs are no-ops.
 */
const ADDITIVE_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'extractions', column: 'length_basis', ddl: `ALTER TABLE extractions ADD COLUMN length_basis TEXT` },
];

/** Create all core tables/indexes if absent. Idempotent. */
export function ensureSchema(db: Db): void {
  for (const stmt of STATEMENTS) db.run(sql.raw(stmt));
  for (const mig of ADDITIVE_COLUMNS) {
    const columns = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${mig.table})`));
    if (!columns.some((c) => c.name === mig.column)) db.run(sql.raw(mig.ddl));
  }
}
