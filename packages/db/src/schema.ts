/**
 * Drizzle schema — mirrors the SQLite DDL in docs/ARCHITECTURE.md §3 exactly.
 * JSON columns are TEXT with Zod validation at the boundary (SQLite JSON1
 * functions available for queries). Epoch-ms timestamps are plain INTEGERs.
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// ── Sources & ingestion ────────────────────────────────────────────────

export const sources = sqliteTable('sources', {
  /** 'ebay' | 'shopify:staud.clothing' | 'fixtures' */
  id: text('id').primaryKey(),
  /** 'ebay' | 'shopify' | 'fixture' | future kinds */
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
  /** per-source config (store domain, category ids…) */
  configJson: text('config_json').notNull().default('{}'),
  /** e.g. '0 6 * * *' (1/day/store politeness) */
  cadenceCron: text('cadence_cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** epoch ms */
  lastRunAt: integer('last_run_at'),
  /** url -> ETag/Last-Modified cache */
  etagJson: text('etag_json').notNull().default('{}'),
});

export const ingestRuns = sqliteTable('ingest_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  /** running|ok|error */
  status: text('status').notNull().default('running'),
  /** {fetched, new, updated, unchanged, errors} */
  statsJson: text('stats_json').notNull().default('{}'),
  error: text('error'),
});

// ── Listings (normalized) ──────────────────────────────────────────────

export const listings = sqliteTable(
  'listings',
  {
    /** `${source_id}:${source_listing_id}` */
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingId: text('source_listing_id').notNull(),
    sourceUrl: text('source_url').notNull(),
    affiliateUrl: text('affiliate_url'),
    title: text('title').notNull(),
    description: text('description'),
    brand: text('brand'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    /** new|like_new|good|fair|unknown */
    condition: text('condition').notNull().default('unknown'),
    isVintage: integer('is_vintage', { mode: 'boolean' }).notNull().default(false),
    /** '1970s' etc, nullable */
    era: text('era'),
    /** raw labels: ["M","8","EU 38"] */
    sizeLabelsJson: text('size_labels_json').notNull().default('[]'),
    /** normalized US numeric: [8, 10] */
    sizeNormalizedJson: text('size_normalized_json').notNull().default('[]'),
    /** per-size in-stock (Shopify variants) */
    availabilityJson: text('availability_json').notNull().default('{}'),
    /** sha256(title|desc|price|images|sizes) → extraction cache key */
    contentHash: text('content_hash').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    /** freshness driver */
    lastSeenAt: integer('last_seen_at').notNull(),
    /** soft delete when source drops it */
    removedAt: integer('removed_at'),
  },
  (t) => [
    unique().on(t.sourceId, t.sourceListingId),
    index('idx_listings_last_seen').on(t.lastSeenAt),
    index('idx_listings_brand').on(t.brand),
    index('idx_listings_price').on(t.priceCents),
  ],
);

export const listingImages = sqliteTable(
  'listing_images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('idx_images_listing').on(t.listingId)],
);

// ── AI extraction (cached by content hash) ─────────────────────────────

export const extractions = sqliteTable(
  'extractions',
  {
    /** cache key: rerun-safe, idempotent */
    contentHash: text('content_hash').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** 'claude-haiku-4-5-20251001' | 'mock' | 'fixture' */
    model: text('model').notNull(),
    /** micro|mini|above_knee|knee|midi|mid_calf|maxi|floor */
    lengthClass: text('length_class'),
    /** nullable; HPS-to-hem */
    lengthInches: real('length_inches'),
    /** {bust,waist,hip,length} inches, all nullable */
    measurementsJson: text('measurements_json').notNull().default('{}'),
    /** [{name,family,hex?}] */
    colorsJson: text('colors_json').notNull().default('[]'),
    fabric: text('fabric'),
    /** Fashionpedia taxonomy value */
    neckline: text('neckline'),
    /** a_line|sheath|wrap|fit_and_flare|slip|shirt|bodycon|tent|empire|other */
    silhouette: text('silhouette'),
    sleeve: text('sleeve'),
    pattern: text('pattern'),
    occasionJson: text('occasion_json').notNull().default('[]'),
    /** sparse {tag: weight} for similarity */
    attributeVectorJson: text('attribute_vector_json').notNull().default('{}'),
    /** 0..1 */
    extractionConfidence: real('extraction_confidence').notNull().default(0),
    extractedAt: integer('extracted_at').notNull(),
    /** audit/debug */
    rawResponseJson: text('raw_response_json'),
  },
  (t) => [index('idx_extractions_listing').on(t.listingId)],
);

// ── Users & profiles ───────────────────────────────────────────────────

export const users = sqliteTable('users', {
  /** uuid, minted on first visit (cookie) */
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  heightInches: real('height_inches'),
  heelPrefInches: real('heel_pref_inches').notNull().default(0),
  /** normalized US sizes user wears: [6, 8] */
  sizesJson: text('sizes_json').notNull().default('[]'),
  /** optional {bust,waist,hip} inches */
  measurementsJson: text('measurements_json').notNull().default('{}'),
  /** preferred hem classes on-body */
  lengthPrefsJson: text('length_prefs_json').notNull().default('[]'),
  coveragePrefsJson: text('coverage_prefs_json').notNull().default('{}'),
  budgetMinCents: integer('budget_min_cents'),
  budgetMaxCents: integer('budget_max_cents'),
  /** one of 12 seasons, nullable */
  colorSeason: text('color_season'),
  /** [{hex,name}] derived palette (selfie is DISCARDED) */
  paletteJson: text('palette_json').notNull().default('[]'),
  /** learned sparse vector {tag: weight} from swipes */
  styleTagsJson: text('style_tags_json').notNull().default('{}'),
  onboardedAt: integer('onboarded_at'),
});

export const userBrandSizes = sqliteTable(
  'user_brand_sizes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brand: text('brand').notNull(),
    /** what fits her in THIS brand */
    sizeLabel: text('size_label').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.brand] })],
);

export const swipeEvents = sqliteTable(
  'swipe_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    /** like|dislike|save|skip */
    verdict: text('verdict').notNull(),
    /** calibration|feed|search */
    context: text('context').notNull().default('feed'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_swipes_user').on(t.userId, t.createdAt)],
);

// ── Ranking cache (cost control) ───────────────────────────────────────

export const rerankCache = sqliteTable('rerank_cache', {
  /** sha256(userProfileHash + candidateIdsHash + queryHash) */
  cacheKey: text('cache_key').primaryKey(),
  /** RankResponse */
  responseJson: text('response_json').notNull(),
  model: text('model').notNull(),
  createdAt: integer('created_at').notNull(),
  /** ~24h TTL */
  expiresAt: integer('expires_at').notNull(),
});
