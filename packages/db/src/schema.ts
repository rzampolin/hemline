/**
 * Drizzle schema — mirrors the SQLite DDL in docs/ARCHITECTURE.md §3 exactly.
 * JSON columns are TEXT with Zod validation at the boundary (SQLite JSON1
 * functions available for queries). Epoch-ms timestamps are plain INTEGERs.
 */
import {
  blob,
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
    /**
     * Additive (2026-07-09, sold-detection): when the verification worker last
     * CONFIRMED this listing live at the source (single-PDP/product.json
     * re-check). NULL = never verified. Distinct from last_seen_at, which any
     * bulk crawl bumps; verified_at is only set on a conclusive per-listing
     * check. Drives oldest-verified-first rolling batch selection.
     */
    verifiedAt: integer('verified_at'),
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
    /**
     * Provenance of length_inches: 'stated' (seller text) | 'image_estimate'
     * (Haiku vision pass, inches ALWAYS present) | 'not_estimable' (vision
     * pass attempted but clamped/not-estimable — inches ALWAYS NULL). NULL
     * means stated (legacy rows) — or, when length_inches is also NULL, that
     * no estimation attempt has been made yet (the extract:lengths queue
     * predicate).
     */
    lengthBasis: text('length_basis'),
    /**
     * Additive (length-estimation v2): which model-height anchor grounded the
     * vision estimate — 'stated_model_height' (parsed from listing text) |
     * 'assumed_default' (5'9" assumption). NULL on non-vision/legacy rows.
     */
    lengthAnchor: text('length_anchor'),
    /** anchor model height in inches (e.g. 70 for a stated 5'10"; 69 default) */
    lengthAnchorHeightIn: real('length_anchor_height_in'),
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
    /**
     * Additive (2026-07-09 data-eng, kids-in-catalog founder bug): who the
     * garment is for — 'adult' | 'child' | NULL (unknown; treated as adult by
     * every filter — never nuke coverage on an unknown). Written by the Haiku
     * extraction (which sees the on-model photo — a kid model is unmistakable)
     * and by the purge script's vision recheck.
     */
    audience: text('audience'),
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

// ── Visual embeddings (additive, 2026-07-07 ml-eng) ────────────────────
// Marqo-FashionSigLIP image vectors, keyed like extractions: by content_hash
// so re-embedding is idempotent, plus the model tag so a model swap coexists
// with old rows. Vector is a Float32Array serialized as a little-endian BLOB.
// Scale note: brute-force cosine over ≤10k × 768-d Float32Arrays is <10ms in
// TS — sqlite-vec is the documented upgrade path when the catalog outgrows it.

export const listingEmbeddings = sqliteTable(
  'listing_embeddings',
  {
    /** matches listings.content_hash at embed time (staleness detector) */
    contentHash: text('content_hash').notNull(),
    /** e.g. 'marqo-fashionSigLIP' (contracts EMBEDDING_MODEL_TAG) */
    model: text('model').notNull(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** vector dimension (768 for FashionSigLIP) */
    dim: integer('dim').notNull(),
    /** L2-normalized Float32Array bytes (little-endian) */
    vector: blob('vector', { mode: 'buffer' }).notNull(),
    /** provenance: which image url was embedded */
    imageUrl: text('image_url'),
    embeddedAt: integer('embedded_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contentHash, t.model] }),
    index('idx_embeddings_listing').on(t.listingId),
  ],
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
  /**
   * Global palette-boost toggle (spec D2; additive 2026-07-08, QA P1 #1).
   * NULL = never set = enabled (historical behavior); 0 disables the
   * server-side ranking boost.
   */
  paletteBoostEnabled: integer('palette_boost_enabled', { mode: 'boolean' }),
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

/**
 * Additive (2026-07-09, hybrid search): GLOBAL cache for stage-3 Haiku query
 * parses. Parses are user-independent ("summer formal" parses once, ever), so
 * the key is just sha256(normalized query). parse_json is the LlmQueryParse
 * payload, or the literal 'null' for a NEGATIVE entry (recent failure, short
 * TTL). Expired rows are deleted lazily on read, like rerank_cache.
 */
export const searchQueryCache = sqliteTable('search_query_cache', {
  /** sha256(lowercased, whitespace-collapsed query) */
  cacheKey: text('cache_key').primaryKey(),
  /** LlmQueryParse JSON, or 'null' (negative entry) */
  parseJson: text('parse_json').notNull(),
  model: text('model').notNull(),
  createdAt: integer('created_at').notNull(),
  /** ~30d TTL (5min for negative entries) */
  expiresAt: integer('expires_at').notNull(),
});

// ── Aux tables (adopted 2026-07-06 from lazy CREATEs in query/{alerts,admin}) ──

/** Spec F4: alert toggles are stored, never sent (no email infra). */
export const pendingAlerts = sqliteTable(
  'pending_alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    listingId: text('listing_id'),
    /** serialized saved-search filters for kind='new_matches' */
    searchJson: text('search_json'),
    /** price_drop | low_stock | new_matches */
    kind: text('kind').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique().on(t.userId, t.listingId, t.kind)],
);

/**
 * Spec G4 (additive, 2026-07-08 QA P1 #4): affiliate click/attribution log.
 * One row per outbound "Shop on …" tap. user_id is nullable (guest clickouts
 * tolerated, no FK so pre-session beacons never fail); the destination URL is
 * stored only as a sha256 hash — enough for dedupe/sold-detection joins via
 * listing_id without keeping full-URL PII at rest.
 */
export const clickouts = sqliteTable(
  'clickouts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    /** nullable: guests without a session are recorded anonymously */
    userId: text('user_id'),
    sourceId: text('source_id').notNull(),
    /** sha256(affiliateUrl ?? sourceUrl) — destination fingerprint, no PII */
    destinationHash: text('destination_hash').notNull(),
    clickedAt: integer('clicked_at').notNull(),
  },
  (t) => [
    index('idx_clickouts_listing').on(t.listingId),
    index('idx_clickouts_time').on(t.clickedAt),
  ],
);

/**
 * First-party product analytics (additive, 2026-07-09). One SMALL row per
 * whitelisted client event (see @hemline/contracts AnalyticsEventSchema —
 * unknown types/props never reach this table). props_json holds enum/number
 * props only; the single free-text exception is the search query. user_id is
 * nullable (guests recorded via anon_id only, no FK so pre-session beacons
 * never fail); anon_id is a client-minted per-browsing-session token.
 */
export const analyticsEvents = sqliteTable(
  'analytics_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** nullable: guests are recorded anonymously (linkage policy: docs/decisions-analytics.md) */
    userId: text('user_id'),
    /** per-browsing-session anon token (sessionStorage uuid) — funnel dedup for guests */
    anonId: text('anon_id').notNull(),
    /** whitelisted event type (contracts ANALYTICS_EVENT_TYPES) */
    eventType: text('event_type').notNull(),
    /** strict per-type props, validated at the API boundary */
    propsJson: text('props_json').notNull().default('{}'),
    /** epoch ms, server-assigned at insert */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_analytics_type_time').on(t.eventType, t.createdAt)],
);

/**
 * Sold/dead-listing verification queue (additive, 2026-07-09 data-eng).
 * One row per listing awaiting an availability re-check: clickouts enqueue
 * here (user interest = highest staleness cost) and the scheduler drains the
 * queue every ~15 min. listing_id is the PK so repeat clicks dedupe to the
 * earliest pending entry. Rows are deleted after the verification attempt.
 */
export const verificationQueue = sqliteTable(
  'verification_queue',
  {
    listingId: text('listing_id')
      .primaryKey()
      .references(() => listings.id),
    /** 'clickout' (user signal) | 'manual' */
    reason: text('reason').notNull(),
    enqueuedAt: integer('enqueued_at').notNull(),
  },
  (t) => [index('idx_verification_queue_time').on(t.enqueuedAt)],
);

/** Spec G2: manual extraction-correction log (prompt-tuning audit trail). */
export const extractionCorrections = sqliteTable('extraction_corrections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contentHash: text('content_hash').notNull(),
  listingId: text('listing_id').notNull(),
  patchJson: text('patch_json').notNull(),
  previousJson: text('previous_json').notNull(),
  correctedAt: integer('corrected_at').notNull(),
});

/**
 * Paste-a-dress-link page-parse cache (additive, 2026-07-13 fit-check).
 * One row per pasted URL: result_json holds the ParsedExternalPage (plus the
 * extraction attributes when one ran) so a repeat paste costs zero fetches
 * and zero AI spend. Successful parses live ~24h; fetch failures are cached
 * as short-TTL NEGATIVE entries (~5min) so a flaky store isn't hammered.
 * Never a listings row — pasted products are ephemeral by design.
 */
export const fitCheckCache = sqliteTable('fit_check_cache', {
  /** sha256(normalized url) */
  urlHash: text('url_hash').primaryKey(),
  /** the pasted URL (post-normalization), for admin/debugging */
  url: text('url').notNull(),
  /** cached parse payload (CachedFitCheckPage JSON) */
  resultJson: text('result_json').notNull(),
  createdAt: integer('created_at').notNull(),
  /** ~24h TTL (~5min for negative entries); expired rows deleted lazily on read */
  expiresAt: integer('expires_at').notNull(),
});
