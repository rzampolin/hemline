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

15. **JSON-LD / sitemap connector (`jsonld:<domain>`, kind `jsonld`)** unlocks
    non-Shopify brands via schema.org Product JSON-LD on PDPs. Discovery:
    `store.sitemapUrl` override → robots.txt `Sitemap:` lines (filtered to the
    store's host — Reformation's robots also lists its .fr sitemap) →
    `/sitemap.xml` fallback; sitemap indexes are followed (product-named
    children preferred, ≤12 sitemap fetches/run), `*.xml.gz` bodies gunzipped.
    Candidate URLs must match the per-store `productUrlPattern` regex; the
    per-run cap (default 500, `JSONLD_MAX_PAGES`) **logs** what it skips, never
    silently truncates. Cadence `30 6 * * *` (daily, offset from the Shopify
    wave); `INGEST_ENABLE_JSONLD=false` disables like the Shopify toggle.
    (EM: both env vars are candidates for `.env.example`.)

16. **Capped crawls are ordered dress-URL-first, then sitemap `lastmod`
    freshest-first.** Verified live on thereformation.com: sitemap-order top-50
    yielded 37 dresses of which 12 had no price and only 24% had sizes
    (archived/sold-out products cluster at old lastmods — their JSON-LD
    collapses to a single sizeless OutOfStock offer); lastmod-ordered top-50
    yielded 50/50 dresses with 100% sizes + per-size availability.

17. **Malformed JSON-LD recovery pass.** whistles.com ships raw control
    characters inside JSON string literals (invalid JSON). On parse failure we
    retry with control chars replaced by spaces; only blocks that still fail
    count as malformed (logged when a PDP has nothing else). Descriptions are
    entity-decoded *before* HTML-stripping (Whistles double-encodes
    `&lt;p&gt;`-markup in `description`).

18. **`priceDivisor` store field.** forloveandlemons.com's theme emits integer
    cents in the JSON-LD `price` field ("21299.00" for a $212.99 dress —
    verified against the on-site price). Auto-detecting that is guesswork, so
    it is explicit per-store config, set only when a probe proves it.

19. **Per-PDP conditional requests.** ETag/Last-Modified is cached per product
    URL in `sources.etag_json` (up to ~500 entries/store, ~50 KB — fine in
    SQLite); a 304 re-emits the stored listing via `loadExistingRawListings`
    keyed by `sourceUrl`, same freshness rationale as decision #2.

20. **Bot-block circuit breaker:** 8 consecutive PDP failures abandon the
    store for the run (Aritzia went from 200s to blanket 403s mid-probe; a
    polite bot stops instead of walking the remaining URL list into a WAF).

21. **jsonld-stores.json vs stores.json boundary: products.json wins.** During
    candidate research, needleandthread.com and veronicabeard.com turned out to
    be Shopify with open products.json → added to *shopify* stores.json
    (verified) instead; the JSON-LD list is for stores the Shopify connector
    cannot crawl. `--store=<domain>` resolves to the JSON-LD connector when the
    domain is configured there, else Shopify (override with
    `--source=shopify:<domain>`). `--source=jsonld:<domain>` requires a
    jsonld-stores.json entry (the connector needs its `productUrlPattern`).
    Notable non-starters, all recorded with notes in jsonld-stores.json:
    realisationpar.com (BigCommerce, Product **microdata** only — a microdata
    parser is the natural follow-up), houseofcb.com (no discoverable sitemap),
    jcrew.com/ba-sh.com (ProductGroup without server-side offers/price),
    anthropologie/freepeople/stories/mango/reiss (bot-blocked), Sézane & Hello
    Molly (known blockers, skipped without new requests).

22. **Brand sanity guard:** FL&L ships `brand: "Ready-to-Wear"` (a category);
    category-ish brand strings fall back to the store display name.

23. **Request to backend-eng:** `normalizeSizeLabels` returns `[]` for
    Reformation's SFCC-padded labels — zero-padded numerics (`"002"`, `"010"`)
    and padded alpha (`"0XS"`, `"00S"`, `"00M"`). Until it learns those, the
    size hard-filter can't match `jsonld:thereformation.com` listings (raw
    labels are stored as-seen per the RawListing contract; hem/length work is
    unaffected).

24. **Per-store brand strategy (`framework/brand.ts`) — vendor is never
    trusted as the brand by default.** Founder-reported prod bug (2026-07-09):
    single-brand storefronts abuse Shopify `vendor` (and schema.org `brand`)
    for internal bookkeeping. Cataloged from the live facet (~249 distinct
    "brands", ~190 junk): christydawn.com season codes (SP23…SP26B, F24A,
    PF25, U25B, BF24B, PS26A, "Summer 24") plus its manufacturer legal entity
    ("OSHADI COLLECTIVE (OPC) PRIVATE LIMITED"); staud.clothing collection
    labels (48 variants of "STAUD <SEASON> <YEAR> [SALE|CORE|EXCLUSIVE|…]");
    petalandpup.com drop codes (~55 of PUP3…PUP139, incl. lowercase pup129);
    sisterjane.com collection names; Rouje place-name collections; RIXO
    decorated/mojibake vendors ("RIXO ⋆", "RIXO â‹†"); Faithfull collab
    labels. Fix: every store in stores.json / jsonld-stores.json now carries
    `brandName` + `brandMode`. 'single' (all 41 Shopify DTC stores; most
    JSON-LD stores) → brand is ALWAYS brandName and the vendor string is
    demoted to an attribute-hint input; 'multi' (lulus.com, madewell.com,
    aritzia.com, anthropologie.com, freepeople.com — retailers that genuinely
    sell third-party labels) → vendor is kept but runs through
    `looksLikeVendorCode` (code shape `^[A-Za-z]{1,6}[-_]?\d{1,4}[A-Za-z]{0,2}$`,
    FW/SS/AW/PF/SP+digits, season-word+year, SALE/PREORDER/OUTLET, legal-entity
    suffixes) and falls back to brandName when it is plainly a code. Ad-hoc
    `--store=<domain>` runs default to 'multi' (historical vendor-wins
    behavior minus the codes).

25. **sisterjane.com is 'single' + `knownBrands: ["Ghospell"]`.** Probed live
    2026-07-09 (one products.json page): vendor is ALWAYS a collection label —
    "DREAM <collection>" (Sister Jane's own DREAM line), "Menswear <collection>",
    bare names ("Voyage Voyage", "Secrets The Water Keeps"), collabs
    ("Petersham Nurseries x Sister Jane"), and "<collection> by Ghospell".
    Ghospell is a genuinely distinct label sold on the storefront, so a
    `knownBrands` hit (word-boundary, case-insensitive, in both modes) maps
    the vendor to it; everything else collapses to "Sister Jane". Same
    mechanism keeps Bo+Tee distinct on ohpolly.com.

26. **Brand does NOT feed content_hash → the brand fix is a plain UPDATE, but
    a migration is still required.** The recipe is
    sha256(title|desc|price|images|sizes) (packages/db/src/content-hash.ts;
    `contentHashFor` picks fields explicitly, so RawListing.brand never feeds
    hashing at ingest either). Consequences: (a) fixing brands cannot orphan
    the content_hash-keyed `extractions` (~$20 of Haiku) or
    `listing_embeddings` (~7k vectors), and the next crawl computes an
    identical hash — zero churn/re-extraction; (b) the connector fix alone
    can never repair existing rows, because the pipeline's unchanged-hash
    path only bumps last_seen_at/availability and never rewrites brand.
    Hence `scripts/fix-brands.ts` (bundled to /app/dist/fix-brands.mjs, same
    esbuild-launcher pattern as prod-seed): recomputes every shopify:/jsonld:
    listing's brand through the SAME `resolveBrand` the connectors use,
    dry-run by default, `--apply` commits in one transaction with a
    before/after orphan-count integrity check that rolls back on any
    discrepancy. eBay/fixture sources are never touched. Prod:
    `fly ssh console -C "node /app/dist/fix-brands.mjs"` then `… --apply`.

27. **Sold/dead-listing verification (2026-07-09).** Between daily crawls a
    sold dress stays fully visible; clickouts (spec G4) made the freshness
    story actionable. A verification worker (`apps/ingest/src/verification.ts`)
    re-checks small batches per source kind, pure HTTP through the existing
    politeness stack (politeFetch: HemlineBot UA, ≥1s/host, one 429/5xx
    retry) — zero AI cost.
    - **Signals.** *Shopify:* one request to the storefront single-product
      `{sourceUrl}.js` — live-probed (staud.clothing wells-dress): `.js`
      carries explicit per-variant `available` booleans and the same
      options/option1-3 shape as products.json (so the shared
      `shopifyAvailability` helper, refactored out of
      `normalizeShopifyProduct`, reads both), while `{sourceUrl}.json` OMITS
      `available` entirely. A `.js` 404 is confirmed against the `.json`
      mirror before marking gone (belt against themes disabling `.js`).
      *JSON-LD:* one PDP fetch through the same `extractListingFromHtml` the
      crawler uses (microdata fallback included); archived PDPs that keep the
      Product node but drop the price (decision #16) are marked sold ONLY on
      an explicit all-OutOfStock offer signal (`explicitStructuredStockSignal`).
      *eBay/fixtures:* unsupported — Browse API auth / no live source; never
      selected or enqueued.
    - **Trigger policy.** (a) Clickout → `verification_queue` (new table,
      listing_id PK = repeat clicks dedupe; enqueue hook in POST
      /api/clickouts, isolated so it can never fail the clickout) drained by
      a `*/15 * * * *` cron (VERIFY_CLICK_CRON, batch VERIFY_QUEUE_BATCH=25)
      — clicks = user interest = highest staleness cost, verified within
      ~15 min. (b) Rolling sweep: `0 * * * *` (VERIFY_ROLLING_CRON) verifies
      VERIFY_ROLLING_BATCH=50 oldest-verified active listings (never-verified
      first, then oldest `verified_at`) so a ~1.6k-listing catalog cycles in
      ~1.5 days at ~50 req/h. VERIFY_ENABLE=false kills both jobs. Manual:
      `npm run verify:listings` / `node /app/dist/verify-listings.mjs`.
    - **State model.** Verified gone/sold → `removed_at = now` (existing
      soft-delete; feed/search already exclude removed, saves keep the row
      for the "possibly sold" rack UX). Size-sold-out → `availability_json`
      rewritten and `size_normalized_json` re-derived from IN-STOCK labels
      only (sizes are the feed hard filter); raw `size_labels_json` is never
      touched — it feeds content_hash (decision #26), and availability is
      unhashed (decision #9) so the next crawl reconciles cleanly. Verified
      fine → `verified_at = now` (additive column). Transient errors
      (network, 429/5xx, unparseable payloads, ambiguous pages) apply NO
      transition — timeout ≠ sold — and a 3-strike per-host circuit breaker
      abandons a blocking store for the run (decision #20 pattern); such
      listings simply come around again in the rolling sweep.
    - **Rack flag fix (end-to-end flip).** GET /api/saves computed
      "possibly sold" from `last_seen_at` staleness alone, but a
      verified-sold listing has a FRESH last_seen_at — `CandidateListing`
      now carries `removedAt` (db-layer type, frozen contract untouched) and
      the staleIds filter flags `removed_at IS NOT NULL` independently.
    - **Live proof (2026-07-09, against a /tmp COPY of prod data — never the
      real db).** staud wells-dress: stored availability from 2 days prior
      showed sizes 2/4/6/12 sold out; live verify → `availability_updated`
      with size 2 back and 4/6/12 out, size_normalized narrowed to
      [0,2,8,10,14,16]. reformation serafina-silk-dress (JSON-LD): all sizes
      InStock → `ok`, verified_at bumped, nothing else changed. christydawn
      adele (oldest unseen): live per-variant map (1X out) matched stored →
      `ok`. Fabricated dead handle on staud.clothing: real 404 on `.js` AND
      `.json` → `gone`, removed_at set.
