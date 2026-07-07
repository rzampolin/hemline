# Data-Eng Decisions (connectors + ingest)

Pragmatic calls made while building `packages/connectors` and `apps/ingest`
where docs/ARCHITECTURE.md was ambiguous or silent. Contracts were not touched.

1. **No `@hemline/db` import in connectors (workspace cycle).** `packages/db`
   already depends on `@hemline/connectors` (seed loads fixtures), so the
   DB-backed `EtagCache` and the 304 re-emit helper access the opaque
   `FetchContext.db` through drizzle's raw-SQL escape hatch
   (`db.get/run/all(sql\`…\`)`) against `sources` / `listings` /
   `listing_images` only. `drizzle-orm` added as a connectors dependency.

2. **304 Not Modified → re-emit existing listings.** The frozen `FetchResult`
   has no "not modified" signal, and returning `[]` would let an *unchanged*
   store go stale and get pruned at 2×cadence. On a page-1 304 the Shopify
   connector reconstructs the source's non-removed listings from the DB
   (`loadExistingRawListings`) with a fresh `seenAt`, so the pipeline counts
   them `unchanged` and bumps `last_seen_at`. Conditional headers are sent on
   page 1 only (page membership shifts across runs; a per-page 304 is not
   reconstructable). Verified live: staud.clothing serves real ETags and the
   second crawl short-circuited after 2 requests (robots + conditional page 1).

3. **User-Agent stays `HemlineBot/1.0 (+CRAWLER_CONTACT)`** per the
   architecture doc §8 and the pre-existing `hemlineUserAgent()` helper (the
   track brief said 0.1; doc + scaffold win). Crawl delay is per-host ≥1s,
   configurable via `HEMLINE_CRAWL_DELAY_MS`.

4. **robots.txt: missing/unreachable → allowed.** Standard for 404; extended
   to network errors to stay dev-friendly (Shopify's default robots.txt does
   not disallow `/products.json`; an explicit Disallow skips the store with a
   warning). Parser implements the REP subset we need: groups, `*` wildcards,
   `$` anchors, longest-match-wins, Allow wins ties.

5. **stores.json carries `verified` + optional `currency` + `note`.**
   41 curated DTC dress brands; 30 probed live on 2026-07-06 (one polite
   `products.json?limit=1` request each, ≥1.5s apart) → `verified: true`.
   Failures kept with notes (Reformation is not Shopify; Réalisation Par /
   House of CB / For Love & Lemons disable products.json; Sézane & Hello Molly
   bot-block; GANNI unreachable; RHODE 402). Free People was excluded up front
   (URBN platform, not Shopify). `currency` is a curated approximation (GBP
   for clearly-UK storefronts, USD default) — products.json exposes no
   presentment currency; follow-up if it matters for ranking.

6. **Only `verified: true` stores are crawled by default** (`npm run ingest`);
   `--store=<domain>` can force any domain (ad-hoc store entry) for probing.

7. **Extraction queue = absence of an `extractions` row.** No new table:
   listings whose `content_hash` has no row in `extractions` are pending —
   exactly the doc's cache-key semantics, and re-seen/changed listings requeue
   automatically because their hash changes. After each upsert the pipeline
   calls `createExtractionService().extractBatch()` (dynamic import, isolated
   try/catch): a stub/missing service leaves listings pending (logged, retried
   next run) and never fails ingest. Returned attributes are written with
   `ON CONFLICT DO NOTHING` so ai-eng's own cache writes always win.

8. **`contentHashFor` is duplicated in `apps/ingest/src/pipeline.ts`.**
   `packages/db/src/seed.ts` exports it but *runs the seed on import* (top-
   level `seed()` call), so it cannot be imported. Same recipe
   (`sha256(title|desc|price|images|sizes)`), verified compatible: re-ingesting
   the seeded fixtures yields 150 `unchanged`. **Request to backend-eng:** move
   the helper to a side-effect-free module in `@hemline/db` and we'll consume it.

9. **Availability is not part of the content hash** (doc recipe omits it), but
   unchanged re-sightings still update `availability_json` so per-size stock
   stays fresh without re-triggering extraction. Re-seen listings also clear
   `removed_at` (revival).

10. **Sub-source ids get their own `sources` rows.** The fixtures connector
    (id `fixtures`) emits listings under `fixture:shopify` / `fixture:ebay`
    (DECISIONS.md #3); the pipeline ensures a `sources` row per distinct
    `RawListing.sourceId` (FK + bookkeeping) plus one for the connector id,
    which carries the ingest_runs / last_run_at / etag state.

11. **Mock flag lives in run stats.** The frozen `FetchResult.stats` is
    `{fetched, errors}` only; `ingest_runs.stats_json` (pipeline-owned) adds
    `mock: true|false` plus `removed/pruned/extracted/extractionPending` for
    the admin dashboard (spec G1).

12. **`cronIntervalMs` is a heuristic** (daily-at-HH → 24h, `*/N` hours/minutes
    → N, day-of-month set → 7d, fallback 24h) used only for the 2×cadence
    staleness window; node-cron does the real scheduling. `sources.cadence_cron`
    overrides the connector default when present (admin-editable, spec G3), and
    `sources.enabled=0` skips a source in both one-shot and watch modes.

13. **eBay live search defaults:** `q=dress`, `category_ids=63861`,
    `buyingOptions:{FIXED_PRICE}`, page size 200, cap `EBAY_MAX_ITEMS` (default
    1000)/run. `EBAY_ASPECT_FILTER` passes a raw Browse-API aspect_filter
    through (e.g. `categoryId:63861,Dress Length:{Midi|Maxi}`). Affiliate:
    `X-EBAY-C-ENDUSERCTX affiliateCampaignId=…` header (API returns
    `itemAffiliateWebUrl`) with a rover-URL fallback built client-side.
    The live path is faked-HTTP-tested; not yet run against real credentials.

14. **Fixture listings with `lastSeenHoursAgo > 48` get `removed_at` on the
    first real ingest run** — that is the 2×cadence rule working as specced
    (soft delete only; rows remain for "possibly sold" UI). Seeded data is
    untouched until you run `npm run ingest`.
