# Hemline — Technical Architecture

**Version:** 1.0 (MVP design) · **Date:** 2026-07-06 · **Author:** Software Architect
**Product:** Personal dress-shopping assistant (mobile-first web) — finds dresses that fit a woman's style, color season, size, and *actual hem position for her height* across resale + DTC brand sites.

---

## 0. Machine survey (drove the DB/embedding decisions)

Investigated on the founder's Mac before finalizing:

| Item | Found | Consequence |
|---|---|---|
| macOS 15.7.7, Apple Silicon (arm64) | ✅ | Native ARM binaries fine (better-sqlite3, sharp ship prebuilds) |
| Node v25.2.1 / npm 11.7.0 | ✅ | Modern Node; Next.js 15 + TS 5 supported |
| Docker 28.3.2 | ✅ installed | *Available* but not required — see DB decision |
| Postgres / psql | ❌ not installed | Embedded DB path chosen |
| Python 3.14.3 (brew) | ✅ | No PyTorch/ML stack installed → local inference embeddings deferred |
| brew sqlite | ✅ | SQLite trivially available |

---

## 1. Stack decisions (one-line justifications)

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router) + TypeScript** | One repo serves mobile-first UI + API routes; zero-config `npm run dev`; the default candidate holds up. |
| Database | **SQLite via `better-sqlite3`** (WAL mode), file at `data/hemline.db` | No Postgres installed; Docker exists but a daemon dependency violates "npm install && npm run dev"; single-user local scale (≤100k listings) is squarely SQLite territory; upgrade path to Postgres is confined to the `db` package. |
| ORM | **Drizzle ORM** (`drizzle-orm/better-sqlite3` + `drizzle-kit` migrations) | Typed schema-as-code that both SQLite today and Postgres later speak; generates the TS types the contracts reuse. |
| Vector / similarity | **v1: Claude-extracted attribute vectors (tag matching in TS)** — no embedding model. Upgrade path: `sqlite-vec` + Marqo-FashionSigLIP behind the `StyleSimilarity` interface | No Python ML stack on the machine; FashionSigLIP needs PyTorch download + a sidecar service and would block 3 of 4 engineers; attribute vectors ship day 1 with zero setup and the interface isolates the swap. |
| LLM SDK | **`@anthropic-ai/sdk` (TypeScript)** | Whole system is TS; no Python service chosen. Haiku 4.5 (`claude-haiku-4-5-20251001`, $1/$5 per MTok) for extraction + re-rank; Sonnet 4.6 (`claude-sonnet-4-6`, $3/$15) for color-season classification where quality matters. |
| Image processing | **`sharp`** (server) + canvas (client) | Deterministic pixel sampling for color analysis; ARM prebuilds, no native toolchain pain. |
| Styling | **Tailwind CSS v4** + a small in-repo component kit (`packages/ui`) | Mobile-first utility CSS, no design-system bikeshedding, works with App Router RSC. |
| Validation | **Zod** everywhere (API boundaries, LLM JSON schemas via `zodOutputFormat`) | One schema definition → runtime validation + TS types + Claude structured-output schema. |
| Testing | **Vitest** (unit, all packages) + **Playwright** (3–5 e2e flows) | Fast, TS-native, both run headless on the Mac; `npm test` wires both. |
| Scheduler | **`node-cron` inside `apps/ingest` worker** | Per-source cadence without launchd/Docker; `npm run ingest` = one-shot, `npm run ingest:watch` = scheduled loop. |
| Auth | **Local-first anonymous cookie session** (signed httpOnly cookie → `users` row); magic-link is a documented later upgrade | Single-founder demo product; no email infra needed; profile is exportable JSON so nothing is lost when real auth lands. |

---

## 2. Repo layout (npm workspaces monorepo) with ownership

Ownership rule: **an engineer owns every file under their directories; cross-module changes go through `packages/contracts` (owned by architect/EM, PR-reviewed by all)**. This is what makes 4-way parallel work merge-conflict-free: contracts land first and freeze.

```
hemline/
├── package.json                    # workspaces root; scripts: dev/ingest/test/db:*   [EM]
├── .env.example                                                                       [EM]
├── drizzle.config.ts                                                                  [backend-eng]
├── data/                           # gitignored: hemline.db, image cache
├── docs/ARCHITECTURE.md            # this file
│
├── packages/
│   ├── contracts/                  # ⭐ ALL cross-module types (this doc §4). LANDS FIRST.
│   │   └── src/{listing,connector,extraction,matching,profile,api,color}.ts   [ARCHITECT/EM — frozen after week 1]
│   │
│   ├── db/                         # Drizzle schema, migrations, query helpers, seed loader
│   │   └── src/{schema.ts,client.ts,migrations/,seed.ts}                      [backend-eng]
│   │
│   ├── connectors/                 # SourceConnector implementations + framework
│   │   └── src/
│   │       ├── framework/{registry.ts,politeness.ts,etag-cache.ts}           [data-eng]
│   │       ├── ebay/               # eBay Browse API (+ mock mode)             [data-eng]
│   │       ├── shopify/            # products.json crawler + seed store list   [data-eng]
│   │       └── fixtures/           # dev/seed connector + fixture JSON         [data-eng]
│   │
│   ├── ai/                         # Everything that calls Anthropic
│   │   └── src/
│   │       ├── client.ts           # SDK wrapper, mock fallback, cost meter    [ai-eng]
│   │       ├── extraction/         # Haiku attribute+measurement extraction    [ai-eng]
│   │       ├── rerank/             # Haiku personalized re-rank                [ai-eng]
│   │       └── color/              # Lab sampling + Sonnet 12-season classify  [ai-eng]
│   │
│   ├── matching/                   # Pure-TS: filters, effective length, attribute similarity, scoring
│   │   └── src/{filters.ts,effective-length.ts,similarity.ts,scoring.ts}     [ai-eng]
│   │
│   └── ui/                         # Shared Tailwind components (Card, SwipeDeck, HemIndicator…)
│       └── src/                                                               [frontend-eng]
│
├── apps/
│   ├── web/                        # Next.js App Router
│   │   ├── app/(marketing)/page.tsx            # landing                      [frontend-eng]
│   │   ├── app/onboarding/**                   # quiz ≤8 screens              [frontend-eng]
│   │   ├── app/calibrate/**                    # swipe deck                   [frontend-eng]
│   │   ├── app/feed/**  app/search/**  app/dress/[id]/**  app/profile/**     [frontend-eng]
│   │   ├── app/color-analysis/**                                              [frontend-eng]
│   │   └── app/api/**                          # route handlers (thin: parse → service → respond)  [backend-eng]
│   │
│   └── ingest/                     # Worker: scheduler → connectors → normalize → extraction queue
│       └── src/{run.ts,schedule.ts,pipeline.ts}                               [data-eng]
│
└── e2e/                            # Playwright specs                          [frontend-eng]
```

Merge-conflict engineering: `apps/web/app/api` (backend) and `apps/web/app/*` pages (frontend) touch disjoint files; data-eng and ai-eng meet only at the `RawListing` → `ExtractionService` contract; the DB schema is backend-owned but reviewed by data-eng + ai-eng in week 1.

---

## 3. Database schema (SQLite DDL)

Drizzle schema mirrors this exactly; DDL shown for precision. JSON columns are `TEXT` with Zod validation at the boundary (SQLite JSON1 functions available for queries).

```sql
PRAGMA journal_mode = WAL;

-- ── Sources & ingestion ────────────────────────────────────────────────
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,          -- 'ebay' | 'shopify:staud.clothing' | 'fixtures'
  kind          TEXT NOT NULL,             -- 'ebay' | 'shopify' | 'fixture' | future kinds
  display_name  TEXT NOT NULL,
  config_json   TEXT NOT NULL DEFAULT '{}',-- per-source config (store domain, category ids…)
  cadence_cron  TEXT NOT NULL,             -- e.g. '0 6 * * *' (1/day/store politeness)
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,                   -- epoch ms
  etag_json     TEXT NOT NULL DEFAULT '{}' -- url -> ETag/Last-Modified cache
);

CREATE TABLE ingest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT NOT NULL REFERENCES sources(id),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL DEFAULT 'running',  -- running|ok|error
  stats_json    TEXT NOT NULL DEFAULT '{}',       -- {fetched, new, updated, unchanged, errors}
  error         TEXT
);

-- ── Listings (normalized) ──────────────────────────────────────────────
CREATE TABLE listings (
  id                 TEXT PRIMARY KEY,      -- `${source_id}:${source_listing_id}`
  source_id          TEXT NOT NULL REFERENCES sources(id),
  source_listing_id  TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  affiliate_url      TEXT,
  title              TEXT NOT NULL,
  description        TEXT,
  brand              TEXT,
  price_cents        INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  condition          TEXT NOT NULL DEFAULT 'unknown', -- new|like_new|good|fair|unknown
  is_vintage         INTEGER NOT NULL DEFAULT 0,
  era                TEXT,                             -- '1970s' etc, nullable
  size_labels_json   TEXT NOT NULL DEFAULT '[]',       -- raw labels: ["M","8","EU 38"]
  size_normalized_json TEXT NOT NULL DEFAULT '[]',     -- normalized US numeric: [8, 10]
  availability_json  TEXT NOT NULL DEFAULT '{}',       -- per-size in-stock (Shopify variants)
  content_hash       TEXT NOT NULL,                    -- sha256(title|desc|price|images|sizes) → extraction cache key
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,                 -- freshness driver
  removed_at         INTEGER,                          -- soft delete when source drops it
  UNIQUE (source_id, source_listing_id)
);
CREATE INDEX idx_listings_last_seen  ON listings(last_seen_at);
CREATE INDEX idx_listings_brand      ON listings(brand);
CREATE INDEX idx_listings_price      ON listings(price_cents);

CREATE TABLE listing_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_images_listing ON listing_images(listing_id);

-- ── AI extraction (cached by content hash) ─────────────────────────────
CREATE TABLE extractions (
  content_hash        TEXT PRIMARY KEY,     -- cache key: rerun-safe, idempotent
  listing_id          TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  model               TEXT NOT NULL,        -- 'claude-haiku-4-5-20251001' | 'mock'
  length_class        TEXT,                 -- micro|mini|above_knee|knee|midi|mid_calf|maxi|floor
  length_inches       REAL,                 -- nullable; HPS-to-hem
  measurements_json   TEXT NOT NULL DEFAULT '{}', -- {bust,waist,hip,length} inches, all nullable
  colors_json         TEXT NOT NULL DEFAULT '[]', -- [{name,family,hex?}]
  fabric              TEXT,
  neckline            TEXT,                 -- Fashionpedia taxonomy value
  silhouette          TEXT,                 -- a_line|sheath|wrap|fit_and_flare|slip|shirt|bodycon|tent|empire|other
  sleeve              TEXT,
  pattern             TEXT,
  occasion_json       TEXT NOT NULL DEFAULT '[]',
  attribute_vector_json TEXT NOT NULL DEFAULT '{}', -- sparse {tag: weight} for similarity
  extraction_confidence REAL NOT NULL DEFAULT 0,    -- 0..1
  extracted_at        INTEGER NOT NULL,
  raw_response_json   TEXT                  -- audit/debug
);
CREATE INDEX idx_extractions_listing ON extractions(listing_id);

-- ── Users & profiles ───────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- uuid, minted on first visit (cookie)
  created_at    INTEGER NOT NULL,
  height_inches REAL,
  heel_pref_inches REAL NOT NULL DEFAULT 0,
  sizes_json    TEXT NOT NULL DEFAULT '[]', -- normalized US sizes user wears: [6, 8]
  measurements_json TEXT NOT NULL DEFAULT '{}', -- optional {bust,waist,hip} inches
  length_prefs_json TEXT NOT NULL DEFAULT '[]', -- preferred hem classes on-body
  coverage_prefs_json TEXT NOT NULL DEFAULT '{}',
  budget_min_cents INTEGER,
  budget_max_cents INTEGER,
  color_season  TEXT,                        -- one of 12 seasons, nullable
  palette_json  TEXT NOT NULL DEFAULT '[]',  -- [{hex,name}] derived palette (selfie is DISCARDED)
  style_tags_json TEXT NOT NULL DEFAULT '{}',-- learned sparse vector {tag: weight} from swipes
  onboarded_at  INTEGER
);

CREATE TABLE user_brand_sizes (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand     TEXT NOT NULL,
  size_label TEXT NOT NULL,                 -- what fits her in THIS brand
  PRIMARY KEY (user_id, brand)
);

CREATE TABLE swipe_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id  TEXT NOT NULL REFERENCES listings(id),
  verdict     TEXT NOT NULL,                -- like|dislike|save|skip
  context     TEXT NOT NULL DEFAULT 'feed', -- calibration|feed|search
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_swipes_user ON swipe_events(user_id, created_at);

-- ── Ranking cache (cost control) ───────────────────────────────────────
CREATE TABLE rerank_cache (
  cache_key    TEXT PRIMARY KEY,            -- sha256(userProfileHash + candidateIdsHash + queryHash)
  response_json TEXT NOT NULL,              -- RankResponse
  model        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL             -- ~24h TTL
);
```

**Freshness model:** every connector sighting bumps `last_seen_at`. Ranking applies exponential decay (§6). Items unseen for `2 × cadence` get `removed_at` set (soft). Query-time re-verification (later): a `verify(listingId)` hook on `SourceConnector` — schema and contract already accommodate it.

---

## 4. Cross-module TypeScript contracts (`packages/contracts`)

These are the frozen interfaces the four engineers build against. All live in `packages/contracts/src/` and import nothing except Zod.

### 4.1 Listing domain (`listing.ts`)

```ts
export type Condition = 'new' | 'like_new' | 'good' | 'fair' | 'unknown';
export type LengthClass =
  | 'micro' | 'mini' | 'above_knee' | 'knee' | 'midi' | 'mid_calf' | 'maxi' | 'floor';
export type Silhouette =
  | 'a_line' | 'sheath' | 'wrap' | 'fit_and_flare' | 'slip' | 'shirt'
  | 'bodycon' | 'tent' | 'empire' | 'other';

export interface Measurements {           // inches, garment flat measurements
  bust: number | null;                     // pit-to-pit × 2 when sourced that way
  waist: number | null;
  hip: number | null;
  length: number | null;                   // HPS (high point shoulder) to hem
}

export interface ColorTag { name: string; family: string; hex: string | null }

/** What a connector emits. Deliberately loose — normalization happens downstream. */
export interface RawListing {
  sourceId: string;                        // 'ebay' | 'shopify:staud.clothing' | 'fixtures'
  sourceListingId: string;
  sourceUrl: string;
  affiliateUrl?: string;
  title: string;
  description?: string;
  brand?: string;
  priceCents: number;
  currency: string;
  imageUrls: string[];
  sizeLabels: string[];                    // raw, as-seen: ["M", "EU 38", "8"]
  availability?: Record<string, boolean>;  // sizeLabel -> in stock
  condition?: Condition;
  isVintage?: boolean;
  era?: string;
  /** connector may pre-fill structured hints (eBay aspects, Shopify tags) */
  attributeHints?: Partial<ExtractedAttributes>;
  seenAt: number;                          // epoch ms
}

/** Unified, enriched listing — the shape the API serves and matching consumes. */
export interface Listing {
  id: string;
  sourceId: string;
  sourceUrl: string;
  affiliateUrl: string | null;
  title: string;
  brand: string | null;
  priceCents: number;
  currency: string;
  images: string[];
  sizeLabels: string[];
  sizeNormalized: number[];                // US numeric sizes
  availability: Record<string, boolean>;
  condition: Condition;
  isVintage: boolean;
  era: string | null;
  colors: ColorTag[];
  lengthClass: LengthClass | null;
  lengthInches: number | null;
  measurements: Measurements;
  fabric: string | null;
  neckline: string | null;
  silhouette: Silhouette | null;
  extractionConfidence: number;            // 0..1
  lastSeenAt: number;
  firstSeenAt: number;
}
```

### 4.2 Connector framework (`connector.ts`) — data-eng ⇄ backend-eng

```ts
export interface FetchContext {
  db: unknown;                             // typed in packages/db; opaque here
  etagCache: EtagCache;
  logger: Logger;
  /** true when required env keys are missing → connector must serve fixtures */
  mockMode: boolean;
}

export interface FetchResult {
  listings: RawListing[];
  stats: { fetched: number; errors: number };
  /** ids the source explicitly reported gone (optional; absence ≠ removal) */
  removedSourceListingIds?: string[];
}

export interface SourceConnector {
  readonly id: string;                     // matches sources.id
  readonly kind: string;                   // 'ebay' | 'shopify' | 'fixture' | ...
  /** cron expression; scheduler reads this. Shopify: max 1/day/store. */
  readonly defaultCadence: string;
  /** Are required credentials present? If false, framework runs it in mockMode. */
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  fetchListings(ctx: FetchContext): Promise<FetchResult>;
  /** Later: query-time re-verification. MVP connectors may return 'unsupported'. */
  verify?(sourceListingId: string): Promise<'active' | 'gone' | 'unsupported'>;
}

export interface EtagCache {
  get(url: string): Promise<{ etag?: string; lastModified?: string } | null>;
  set(url: string, v: { etag?: string; lastModified?: string }): Promise<void>;
}
export interface Logger { info(msg: string, meta?: object): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
```

Adding a future connector (Apify/Poshmark, affiliate feeds) = one file implementing `SourceConnector` + one row in `sources`. The framework provides politeness (per-host rate limit, identified User-Agent `HemlineBot/1.0 (+contact email)`), ETag caching, and mock-mode fallback for free.

### 4.3 Extraction service (`extraction.ts`) — ai-eng ⇄ data-eng

```ts
export interface ExtractedAttributes {
  lengthClass: LengthClass | null;
  lengthInches: number | null;
  measurements: Measurements;
  colors: ColorTag[];
  fabric: string | null;
  neckline: string | null;
  silhouette: Silhouette | null;
  sleeve: string | null;
  pattern: string | null;
  occasions: string[];
  /** sparse tag→weight vector used for style similarity (v1) */
  attributeVector: Record<string, number>;
  confidence: number;                      // 0..1
}

export interface ExtractionInput {
  contentHash: string;                     // cache key — service MUST check cache first
  title: string;
  description: string | null;
  brand: string | null;
  primaryImageUrl: string | null;          // Haiku vision on ONE image max
  attributeHints: Partial<ExtractedAttributes> | null;
  sizeLabels: string[];
}

export interface ExtractionService {
  /** Idempotent: cache hit → no API call. Batches internally (up to 100/call window). */
  extractBatch(inputs: ExtractionInput[]): Promise<Map<string, ExtractedAttributes>>;
  /** 'live' (API key present) or 'mock' (deterministic rule-based fallback) */
  readonly mode: 'live' | 'mock';
}
```

### 4.4 Matching & ranking (`matching.ts`) — ai-eng ⇄ backend-eng

```ts
export interface HardFilters {
  sizesNormalized?: number[];
  priceMinCents?: number;
  priceMaxCents?: number;
  lengthOnBody?: HemPosition[];            // "I want dresses that hit knee/midi ON ME"
  conditions?: Condition[];
  brands?: string[];
  colorFamilies?: string[];
  query?: string;                          // free-text (FTS over title/brand/desc)
}

export type HemPosition =
  | 'upper_thigh' | 'above_knee' | 'knee' | 'below_knee' | 'mid_calf' | 'ankle' | 'floor';

export interface HemResult {
  position: HemPosition | null;            // null when nothing to compute from
  hemAboveFloorInches: number | null;
  basis: 'measured_length' | 'length_class_prior' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

export interface RankRequest {
  userId: string;
  filters: HardFilters;
  limit: number;                           // page size, e.g. 24
  cursor?: string;
  /** false → pure deterministic scoring (no LLM), used for cheap pagination */
  personalize: boolean;
}

export interface RankedListing {
  listing: Listing;
  hem: HemResult;                          // computed for THIS user
  score: number;                           // final blended score 0..1
  whyItWorks: string | null;               // one-liner from Haiku re-rank (top-N only)
  freshnessDecay: number;                  // 0..1 multiplier applied
}

export interface RankResponse {
  items: RankedListing[];
  nextCursor: string | null;
  totalMatched: number;
  rerank: { mode: 'llm' | 'deterministic' | 'cache'; costUsd: number | null };
}

export interface MatchingService {
  rank(req: RankRequest): Promise<RankResponse>;
  hemForUser(listing: Pick<Listing,'lengthInches'|'lengthClass'>, heightInches: number, heelInches?: number): HemResult;
}
```

### 4.5 User profile (`profile.ts`) — backend-eng ⇄ frontend-eng

```ts
export interface UserProfile {
  id: string;
  heightInches: number | null;
  heelPrefInches: number;
  sizesNormalized: number[];
  bodyMeasurements: { bust: number | null; waist: number | null; hip: number | null };
  brandSizes: { brand: string; sizeLabel: string }[];
  lengthPrefs: HemPosition[];
  coveragePrefs: { sleeves?: boolean; highNeckline?: boolean; backCoverage?: boolean };
  budget: { minCents: number | null; maxCents: number | null };
  colorSeason: ColorSeason | null;
  palette: { hex: string; name: string }[];
  styleTags: Record<string, number>;       // learned from swipes
  onboarded: boolean;
}

export type ColorSeason =
  | 'bright_winter' | 'true_winter' | 'dark_winter'
  | 'bright_spring' | 'true_spring'  | 'light_spring'
  | 'light_summer'  | 'true_summer'  | 'soft_summer'
  | 'soft_autumn'   | 'true_autumn'  | 'dark_autumn';

export interface SwipeEvent {
  listingId: string;
  verdict: 'like' | 'dislike' | 'save' | 'skip';
  context: 'calibration' | 'feed' | 'search';
}
```

### 4.6 Color analysis (`color.ts`) — ai-eng ⇄ frontend-eng

```ts
export interface MeasuredColors {          // deterministic pixel sampling output (Lab space)
  skin: { L: number; a: number; b: number; hex: string };
  hair: { L: number; a: number; b: number; hex: string };
  eyes: { L: number; a: number; b: number; hex: string } | null;
  /** derived scalar features the classifier is grounded on */
  contrast: number;                        // |L_hair − L_skin| normalized 0..1
  warmth: number;                          // skin b* leaning, normalized −1..1
  chroma: number;                          // avg chroma, normalized 0..1
  sampleQuality: 'good' | 'poor';          // lighting/size heuristics
}

export interface ColorAnalysisResult {
  season: ColorSeason;
  confidence: number;
  palette: { hex: string; name: string }[];      // 10–14 recommended dress colors
  avoid: { hex: string; name: string }[];
  explanation: string;                            // grounded in the measured values
  measured: MeasuredColors;                       // returned so the user can inspect/edit
  caveat: string | null;                          // set when sampleQuality='poor' or deep/olive skin ranges → suggest quiz
}
```

### 4.7 API surface (`api.ts`) — REST route handlers under `apps/web/app/api`

All bodies/queries validated with Zod; every response is `{ ok: true, data } | { ok: false, error: { code, message } }`.

| Method & path | Request | Response `data` | Notes |
|---|---|---|---|
| `GET /api/session` | — | `UserProfile` | Mints anonymous user + cookie on first hit |
| `PATCH /api/profile` | `Partial<UserProfile>` (Zod-pruned) | `UserProfile` | Onboarding writes here incrementally |
| `PUT /api/profile/brand-sizes` | `{brand,sizeLabel}[]` | `UserProfile` | |
| `POST /api/swipes` | `SwipeEvent[]` | `{ styleTags: Record<string,number> }` | Updates learned vector inline |
| `POST /api/rank` | `RankRequest` (userId from cookie) | `RankResponse` | Feed + search both use this |
| `GET /api/listings/:id` | — | `{ listing: Listing; hem: HemResult; similar: Listing[] }` | Product detail |
| `POST /api/color-analysis` | multipart `{ selfie: File }` | `ColorAnalysisResult` | Image processed in-memory, **never persisted** |
| `POST /api/color-analysis/quiz` | `{ answers: QuizAnswers }` | `ColorAnalysisResult` | Manual fallback path |
| `PUT /api/color-analysis` | `{ season: ColorSeason }` | `UserProfile` | User edits/overrides result |
| `GET /api/meta/filters` | — | `{ brands: string[]; colorFamilies: string[]; priceRange: [number,number] }` | Populates filter UI |
| `POST /api/admin/ingest` | `{ sourceId?: string }` | `{ runId: number }` | Dev convenience; triggers one-shot ingest |

```ts
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
```

---

## 5. Effective-length algorithm (signature feature)

**Goal:** classify where a garment's hem falls **on this user's body**, not the vendor's "midi" label.

### Formula

```
H  = user height in inches (heels: H_eff = H + heelInches × 0.85; heel raises hem proportionally less than heel height)
L  = garment length in inches, HPS (high-point-shoulder) to hem
S  = 0.82 × H_eff        # approx. HPS-to-floor distance (nape/shoulder line sits ~18% of height below crown)

hemAboveFloor = S − L
r = hemAboveFloor / H_eff   # normalized hem height, unitless → bands are height-independent
```

### Classification bands (anthropometric landmark fractions of height)

| `r` range | HemPosition | Landmark rationale |
|---|---|---|
| r > 0.42 | `upper_thigh` | mid-thigh ≈ 0.40 H |
| 0.31 < r ≤ 0.42 | `above_knee` | |
| 0.26 < r ≤ 0.31 | `knee` | knee crease ≈ 0.285 H |
| 0.20 < r ≤ 0.26 | `below_knee` | classic "midi" start |
| 0.12 < r ≤ 0.20 | `mid_calf` | calf midpoint ≈ 0.16 H |
| 0.03 < r ≤ 0.12 | `ankle` | ankle ≈ 0.039 H + margin |
| r ≤ 0.03 | `floor` | |

Because bands are fractions of *her* height, the same 44″ dress correctly classifies as `mid_calf` on a 5'2″ user (r=0.135) and `below_knee`→`knee` on a 5'10″ user (r=0.216) — this is the product's core demo moment.

### Fallbacks & confidence

1. **`length_inches` present** → formula above; `basis='measured_length'`, `confidence='high'` (measurement came from seller text) or `'medium'` (Haiku estimated from image).
2. **Only `length_class`** → map class to a canonical length *for a 5'6″ reference body*, then run the formula: micro 30″, mini 33″, above_knee 36″, knee 39″, midi 44″, mid_calf 47″, maxi 55″, floor 60″. `basis='length_class_prior'`, `confidence='medium'`; widen to two adjacent bands in UI copy ("likely hits knee–below-knee on you").
3. **Neither** → `position=null`, `basis='none'`; item still rankable but hem filter excludes it unless user opts into "unknown length".

### Edge cases

- **Petite (< 62″) / tall (> 69″):** no special-casing needed for classification (proportional bands), but ±1-band uncertainty widens: individual torso:leg ratio varies ~±3% of H, so UI always shows a range at `confidence != 'high'`.
- **Measured-from-waist skirts / drop-waist:** if the seller measurement is waist-to-hem (detected by extraction: "waist to hem 24in"), use `S_waist = 0.62 × H_eff` instead of 0.82.
- **Knit/bias fabrics:** extraction flags stretchy fabric → subtract 1″ from effective hem height (drape), noted in confidence.
- **Heels:** user sets `heelPrefInches` (default 0); applied as above so "with your usual 2″ heel this hits mid-calf".
- **Vintage sizing:** vintage `size_labels` are treated as a *weak prior* in size filtering — a vintage "12" matches modern 6–10 unless garment measurements exist, in which case measurements ± silhouette ease win (ease table: bodycon +1″, sheath/slip +1.5″, a_line/wrap +2.5″, tent/empire +4″ over body measurements).

Implementation is a pure function in `packages/matching/src/effective-length.ts` with an exhaustive Vitest table (petite/average/tall × every band boundary × heel offsets).

---

## 6. Ranking pipeline

```
candidates = SQL hard filters (size ∩ price ∩ hem-position-for-user ∩ condition ∩ brand ∩ FTS query)
             → cap 500 newest-first
score₀     = attributeSimilarity(user.styleTags, listing.attributeVector)      # cosine over sparse tags
           × paletteBoost(user.palette, listing.colors)                        # soft: 1.0–1.25
           × freshnessDecay = exp(−ln2 · ageDays / halfLifeDays)               # halfLife: 7d resale, 21d DTC
top-N (50) → Haiku re-rank (attributes only, no images) → ranked ids + one-line "why"
blend      = 0.6 · llmRank + 0.4 · score₀ ; cache by (profileHash, candidateHash, queryHash) 24h
```

Deterministic path (`personalize:false`, pagination beyond page 1, mock mode) skips the LLM entirely — the app is fully functional without it.

---

## 7. AI pipeline design

### 7.1 Models & budget

| Task | Model | Est. cost |
|---|---|---|
| Attribute/measurement extraction (bulk ingest) | `claude-haiku-4-5-20251001` via **Batches API** (50% off → $0.50/$2.50 per MTok) | ~1.2k in / 300 out tokens per listing ≈ **$0.0013/listing**; 10k listings ≈ $13 one-time, pennies/day incremental |
| Personalized re-rank | `claude-haiku-4-5-20251001`, live, prompt-cached | 50 candidates × ~80 tok summaries + profile ≈ 5k in / 700 out ≈ **$0.008/query** — under the $0.01 budget; cache hits are $0 |
| Color-season classification | `claude-sonnet-4-6` (quality matters, ~1/user lifetime) | ~1k in / 500 out ≈ **$0.01/analysis** |

Cost meter in `packages/ai/src/client.ts` sums `usage` from every response into a daily ledger (logged + surfaced at `/api/admin/ingest`); hard daily cap via `AI_DAILY_BUDGET_USD` (default 5) — exceeded → automatic mock/deterministic mode.

### 7.2 Extraction (Haiku, JSON-schema-constrained)

- **Prompt strategy:** stable system prompt (Fashionpedia-derived closed vocabularies for neckline/silhouette/fabric/pattern embedded as enums — the *schema* enforces the taxonomy, the prompt explains edge cases like "pit to pit is half bust") with `cache_control: {type:'ephemeral'}` on the system block; volatile listing content in the user turn. Order: instructions → taxonomy → listing text → (optional) one image.
- **Structured output:** `client.messages.parse()` with `zodOutputFormat(ExtractedAttributesSchema)` — same Zod schema as the contract, `additionalProperties: false`, enums for every taxonomy field. Guaranteed parseable JSON.
- **Measurement text extraction** is text-only (no image needed): the schema includes `measurements` and the prompt teaches conversions (`"pit to pit 18in"` → bust 36; `length 39"` → 39; cm → inches).
- **Image use:** at most one image per listing (primary), only when text confidence would be low (missing silhouette/length_class after a first text-only pass) — two-pass design halves vision token spend.
- **Batching:** ingest enqueues `ExtractionInput`s; the service flushes via the **Message Batches API** (up to 10k requests/batch, results within ~1h — fine for a daily crawl). A `--live` flag uses sequential live calls for small incremental runs.
- **Idempotency/caching:** `content_hash = sha256(title|description|priceCents|imageUrls|sizeLabels)` is the primary key of `extractions`. Re-running ingest re-extracts nothing unless content changed. Mock and live results share the table (`model` column distinguishes).

### 7.3 Re-rank (Haiku)

Input: user profile summary (~120 tokens) + numbered candidate summaries (id, brand, price, silhouette, colors, hem-position-on-user, fabric, condition). Output schema: `{ ranking: string[], reasons: Record<string,string> }` (one sentence each, "why it works for *you*"). System prompt + profile block are prompt-cached; candidates vary per request. Response cached in `rerank_cache` 24h.

### 7.4 Color analysis (grounded, privacy-first)

1. Client: selfie capture with an oval face guide (plain `<input capture>` + canvas preview) → POST multipart.
2. Server (`sharp`, in-memory only): fixed-region sampling relative to the guide oval — cheek patches (skin), forehead-top strip extended upward (hair), optional user-tapped eye points sent as normalized coords. Median-filter each region, drop specular highlights/shadows (top/bottom 20% luminance), convert sRGB → CIE Lab (D65). Compute contrast/warmth/chroma scalars. **Buffer discarded after sampling — never written to disk or DB.**
3. Sonnet classifies **from the measured Lab numbers only** (the image is not sent): schema-constrained `ColorAnalysisResult`, prompt contains the 12-season decision rubric (value/warmth/chroma axes) so the model maps measurements → season, not vibes.
4. Known accuracy caveats for deep and olive skin tones (Lab warmth axis is less discriminative there; consumer lighting worsens it): when skin L* < 35 or sampleQuality='poor', response carries a `caveat` and the UI offers the **manual quiz fallback** (`/api/color-analysis/quiz`: vein color, jewelry metal, white-vs-cream, sun reaction, natural hair/eye combos → deterministic scoring table, no LLM needed).
5. Result is editable (`PUT /api/color-analysis`); only `colorSeason` + `palette` persist on the profile.
6. Palette → soft ranking boost only (never a hard filter).

### 7.5 Graceful degradation without `ANTHROPIC_API_KEY`

| Capability | Live | Degraded (no key / budget cap) |
|---|---|---|
| Extraction | Haiku batch | Deterministic rule engine: regex measurements (`/(\d{2}(\.\d)?)\s*(in|"|inch)/`, pit-to-pit, cm), keyword taxonomy match for silhouette/neckline/color; `confidence ≤ 0.4`; plus fixtures ship **pre-extracted** attributes so the demo feed is rich |
| Re-rank | Haiku | Deterministic score₀ only; `whyItWorks` templated ("Matches your midi preference and soft-autumn palette") |
| Color analysis | Sonnet | Deterministic season lookup table over the same measured Lab features + always-offered quiz |
| UI | — | Banner: "AI features in demo mode — add ANTHROPIC_API_KEY to .env" |

Everything degrades per-capability, so a missing eBay key + present Anthropic key (or vice versa) still yields a working app.

---

## 8. Connectors (data-eng detail)

- **eBay Browse API** (`ebay/`): OAuth client-credentials; `q=dress` + `category_ids` (women's dresses) + `aspect_filter` for size/color/dress-length/condition; EPN affiliate params appended to item URLs when `EBAY_AFFILIATE_CAMPAIGN_ID` set. `isConfigured()` checks `EBAY_CLIENT_ID/SECRET`; absent → framework runs it against `fixtures/ebay-sample.json` **with a visible `[MOCK]` log and `sources.id='ebay'` stats flagged `mock:true`**.
- **Shopify crawler** (`shopify/`): seed list `shopify/stores.json` (~40 real DTC dress brands: staud.clothing, realisationpar.com, rouje.com, withjean.com, faithfullthebrand.com, reformation… — data-eng curates & verifies `products.json` is open). Paginates `https://{store}/products.json?limit=250&page=N` until empty; filters `product_type/tags` to dresses; variants → per-size availability + prices; `ETag`/`If-None-Match` respected via `EtagCache`; ≥1s delay between requests per host; UA `HemlineBot/1.0 (+rzampolin15@gmail.com)`; cadence 1/day/store.
- **Fixtures** (`fixtures/`): ~150 hand-curated listings (JSON, images hotlinked from public product pages or bundled placeholders) spanning every silhouette/length/price band **with pre-baked extractions** — this is the zero-key demo dataset and the test corpus.

Scheduler (`apps/ingest`): reads `sources` rows, registers `node-cron` jobs per cadence, runs pipeline: `fetchListings → upsert listings (bump last_seen_at, recompute content_hash) → diff → enqueue changed hashes for extraction → flush extraction batch → log ingest_run`.

---

## 9. Dev workflow

### 9.1 `.env.example`

```bash
# ── Anthropic (optional — app runs in demo mode without it) ─────────────
ANTHROPIC_API_KEY=            # sk-ant-...
AI_DAILY_BUDGET_USD=5         # hard cap; exceeded → automatic mock mode
EXTRACTION_MODEL=claude-haiku-4-5-20251001
RERANK_MODEL=claude-haiku-4-5-20251001
COLOR_MODEL=claude-sonnet-4-6

# ── eBay Browse API (optional — connector serves fixtures without it) ──
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_MARKETPLACE=EBAY_US
EBAY_AFFILIATE_CAMPAIGN_ID=   # EPN campaign; blank → source_url used as-is

# ── App ─────────────────────────────────────────────────────────────────
DATABASE_PATH=./data/hemline.db
SESSION_SECRET=change-me-32-chars-minimum-random
CRAWLER_CONTACT=rzampolin15@gmail.com   # goes in bot User-Agent
INGEST_ENABLE_SHOPIFY=true    # set false to skip real network crawls in dev
```

### 9.2 Setup & scripts (root `package.json`)

```bash
git clone … && cd hemline
cp .env.example .env          # keys optional
npm install                   # workspaces install everything
npm run db:migrate            # drizzle-kit push → creates data/hemline.db
npm run db:seed               # loads fixtures: 150 listings + extractions + demo profile
npm run dev                   # next dev (apps/web) on :3000 — fully demo-able NOW, zero keys
```

| Script | What it does |
|---|---|
| `npm run dev` | `next dev` for `apps/web` (API routes included) |
| `npm run ingest` | One-shot: all enabled sources → normalize → extract (batch or mock) |
| `npm run ingest:watch` | Long-running scheduler (node-cron per source cadence) |
| `npm run ingest -- --source=shopify:staud.clothing` | Single source |
| `npm run db:migrate` / `db:seed` / `db:studio` | Migrations / fixtures / Drizzle Studio browser |
| `npm test` | Vitest across all workspaces |
| `npm run test:e2e` | Playwright against a seeded dev server |
| `npm run typecheck` / `lint` | `tsc -b` + eslint (CI gate) |

### 9.3 Seed/fixture strategy (demo-able with zero external keys)

`packages/db/src/seed.ts` loads: fixture listings **with pre-computed extractions** (so feed, filters, hem indicator, similarity all work), one demo user (5'4″, sizes 6–8, soft-autumn, midi preference) so the personalized feed renders before onboarding, and 30 synthetic swipe events. Playwright runs against exactly this seed → deterministic e2e.

### 9.4 Test strategy

- **Unit (Vitest):** effective-length band table (petite/tall/heels/boundaries) · size normalization (EU/UK/vintage) · measurement regex extractor · similarity/scoring math · connector normalizers against recorded JSON (eBay sample response, one real `products.json` snapshot) · mock extraction determinism.
- **Contract tests:** every `SourceConnector` runs through a shared suite (`connectors/framework/__tests__/conformance.ts`) — emits valid `RawListing`s, honors mockMode, idempotent re-run.
- **API tests:** route handlers invoked directly with seeded DB (no server needed).
- **e2e (Playwright, 4 flows):** onboarding quiz → feed renders · search + filter → detail shows correct hem text for demo user height · swipe calibration updates feed order · color quiz fallback → palette on profile. (Selfie flow is unit-tested at the sampling function; e2e uses the quiz path to stay deterministic.)
- **Live-API smoke tests:** `npm run test:live` (skipped unless `ANTHROPIC_API_KEY` set) — one extraction, one re-rank, schema-validates responses.

---

## 10. Build order & parallelization notes (for the EM)

**Week 0 (blocking, ~2 days, architect + backend-eng pair):**
1. Repo scaffold, workspaces, CI (`typecheck`+`test`), `.env.example`.
2. `packages/contracts` — **land and freeze**; changes after this require a 4-party PR review.
3. `packages/db` schema + migrations + minimal seed. Everything downstream reads/writes through it.

**Then four parallel tracks (no shared files):**

| Track | Engineer | Deliverables (in order) | Depends on |
|---|---|---|---|
| A | data-eng | fixtures connector → framework (registry/politeness/etag) → Shopify crawler → eBay (+mock) → scheduler | contracts, db |
| B | ai-eng | mock extractor (unblocks A immediately) → Haiku extraction + batch + cache → matching/effective-length/similarity → re-rank → color analysis | contracts; db read-only |
| C | backend-eng | session/profile routes → `/api/rank` wired to deterministic scoring → listings/detail → swipes → color routes (stub → B's service) → admin/ingest | contracts, db |
| D | frontend-eng | UI kit + landing → onboarding quiz → feed/search against **seeded API from day 1** → detail w/ hem indicator → swipe deck → color flow → profile | contracts; C's routes (stubbed shapes are in contracts, so D can build against MSW mocks before C lands) |

**Integration checkpoints:** end of week 1 — fixtures-only vertical slice (seed → feed → detail with hem indicator) demo; end of week 2 — live Shopify crawl + live Haiku extraction + personalized re-rank; week 3 — eBay + color analysis + e2e green.

**Critical-path risks to watch:** (1) contracts churn — resist post-freeze changes, additive only; (2) Shopify store list quality — data-eng should verify all ~40 `products.json` endpoints in week 1 (some stores disable it); (3) re-rank latency (~1–2s) — frontend must design feed for streamed/optimistic render with deterministic order first, LLM order swapped in when ready; (4) `better-sqlite3` is synchronous — keep it out of hot request paths via prepared statements (fine at this scale) and never import it into client components.

**Deferred (designed-for, not built):** magic-link auth, FashionSigLIP embeddings + `sqlite-vec`, query-time `verify()` re-verification, Apify Poshmark/Depop connector, Postgres migration.
