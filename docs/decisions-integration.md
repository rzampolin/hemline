# Integration decisions (2026-07-06)

Calls made merging the four engineers' tracks into one working system.
Companion to docs/DECISIONS.md and the four decisions-*.md logs. All contract
changes are additive/optional (EM-approved).

## Contracts (additive only)

1. **`HardFilters.sources?: string[]`** — source ids OR the kind aliases
   `'resale' | 'brand'`, which the backend expands
   (`expandSourceFilter`, same source-id heuristic as the freshness
   half-life: `/(^|:)ebay|poshmark|depop|resale/i`). Resolves frontend
   friction #6 and aligns `/api/rank`, `/api/search`, and the filter sheet.
2. **`RankedListing.paletteMatch?: boolean`** — server-computed via
   `packages/matching paletteMatchesColor` (name match or RGB distance ≤ 80).
   The "in your palette" chip no longer needs client-side color math in live
   mode; the client hex→family fallback remains for the mock layer.
3. **`ListingDetailResponse.whyItWorks?: string | null`** — server-composed
   one-liner (templated keyless via `@hemline/ai templatedWhy`, Haiku when
   keyed). Detail page prefers it; client composition remains as mock fallback.
4. **`ColorAnalysisResult.source?: 'selfie' | 'quiz'`** — set inside
   packages/ai. Quiz results carry SYNTHESIZED `measured` values (no selfie
   sampled) and are now labeled (resolves decisions-ai-eng.md #15).
5. **`StyleSimilarity` + `SwipeSignal` promoted into `@hemline/contracts`**
   (requested in decisions-ai-eng.md #6). `SwipeSignal.verdict` inlines the
   verdict union instead of importing `SwipeEvent` — profile.ts imports
   matching.ts, so the reverse import would be a module cycle.
   packages/matching re-exports both for back-compat.

## Backend wiring (training wheels removed)

6. **`apps/web/app/api/lib/matching.ts` is now wiring, not math.** It creates
   `createMatchingService` per request with ports: profile pre-loaded by the
   route, `loadCandidates` → `queryCandidates` (SQL hard filters), `rerank` →
   `@hemline/ai createReranker`. All INLINE §5/§6 copies and try/catch stub
   guards are deleted; `apps/web/app/api/lib/color.ts` (fallback season tables)
   is deleted outright. One shared `AiClient` per process so the cost
   meter/budget ledger accumulates across requests.
7. **`rerank.mode: 'llm'` keyless was a route-lib bug, not packages/ai.**
   The old `rankCandidates` set `mode='llm'` whenever `ai.rerank()` resolved —
   but the reranker resolves *successfully* with its deterministic fallback
   and honestly reports `mode:'deterministic'`. The real MatchingService
   propagates the reranker's own mode; tests now assert
   `deterministic` + `costUsd:null` keyless. (`'cache'` appears on
   rerank_cache hits, live mode only — the deterministic path is never cached.)
8. **Real extraction vectors flow into similarity.**
   `MatchingPorts.loadCandidates` now returns `Listing & { attributeVector? }`
   (additive change in packages/matching, resolving its own decision-#9 TODO):
   the derivation `attributeVectorOf` can't reconstruct
   `pattern:/occasion:/vibe:` tags that the seeded vectors and learned
   styleTags use. The route strips the vector before serializing.
9. **Filter split between SQL and the in-memory predicate set:**
   - SQL (`queryCandidates`): price, condition, brand, color family, source,
     freshness window, free-text query, **and sizes**.
   - Matching service: `lengthOnBody` (per-user hem math).
   - Sizes stay SQL-side (strict normalized-label match): re-applying
     `sizeCompatible` would flip vintage behavior (weak-prior shift excludes
     exact vintage label matches the API/UI already ship). The vintage prior
     + measurement-fit logic in packages/matching stays available; adopting it
     needs a product decision.
   - `query` is deliberately NOT re-applied in-memory: `matchesQuery` sees
     title+brand only (Listing carries no description) and would drop
     SQL matches found in descriptions. Consequence: the reranker doesn't
     receive the query string keyless (irrelevant) or live (minor).
10. **`whyItWorks` is always filled on returned pages** (spec §7.5 table):
    the reranker's reasons when present, `templatedWhy` otherwise — including
    `personalize:false`, matching the pre-integration API behavior.
11. **Color routes call packages/ai directly.** Selfie POST: real sharp Lab
    sampling in memory (never persisted), deterministic rule-table
    classification keyless; undecodable bytes → clean
    `400 invalid_image` (previously a fake hash-based season). API tests use
    a real generated PNG now.
12. **find-similar** uses the real ExtractionService; the route-level keyword
    extractor is deleted (the mock rule engine in packages/ai covers keyless).
    `extractionMode` reports `'live' | 'mock'` (was `'ai' | 'keyword'`);
    `fallback: 'nearest'` unchanged. Probe hashes never hit a listings row, so
    the in-memory cache default is fine there.

## AI cache persistence (ports → Drizzle)

13. **`packages/db/src/query/ai-cache.ts`** implements ai-eng's injected ports
    STRUCTURALLY (db cannot depend on @hemline/ai — ai sits above db):
    - `createExtractionCacheStore` ⇄ `extractions` table. `set()` skips
      hashes with no listings row (ad-hoc probes) and never overwrites
      `model='manual'` (spec G2 corrections) or `model='fixture'` (seed ground
      truth) rows.
    - `createRerankCacheStore` ⇄ `rerank_cache` (24h TTL, lazy expiry on read).
    Wired into the reranker (web routes) and the ingest extraction hand-off.

## db / ingest hygiene

14. **`contentHashFor` lives in `packages/db/src/content-hash.ts`**
    (side-effect-free); seed and the ingest pipeline import it
    (decisions-data-eng.md #8 resolved — note seed.ts had already gained a
    main-module guard, but the single-home rule stands). `pipeline.ts`
    re-exports it for its tests.
15. **`pending_alerts` + `extraction_corrections` adopted into schema.ts +
    ddl.ts**; the lazy `CREATE TABLE IF NOT EXISTS` machinery in
    query/{alerts,admin}.ts is gone (same DDL, so existing dbs are compatible
    and `drizzle-kit push` detects no changes).
16. **Ingest skips manually-corrected listings**: the extraction queue
    excludes any listing with an `extractions` row where `model='manual'` —
    even when its content hash changed — so re-ingest can never clobber human
    QA (decisions-backend-eng.md #7 integration note).
17. **`POST /api/admin/ingest` runs the real pipeline** via the new
    programmatic entrypoint `@hemline/ingest` (`runIngestForSource`;
    `apps/ingest/src/index.ts`, which deliberately does not import
    schedule.ts/node-cron). A trigger `ingest_runs` row is inserted
    immediately and updated on completion; fixture sources are awaited
    (fast, deterministic), network sources run fire-and-forget.
    `fixture:*` sub-source ids resolve to the `fixtures` connector.
18. **Connectors: fixture/ebay-sample JSON loads are static imports** instead
    of `fs.readFileSync(new URL(..., import.meta.url))` — inside the Next
    server bundle `import.meta.url` is not a `file://` URL and the admin
    ingest trigger crashed ("Received an instance of URL"). `structuredClone`
    preserves the fresh-copy-per-call semantics. (Shopify's stores.json
    already used a static import.)

## Frontend ↔ backend

19. **Rack uses the real endpoints**: `GET/POST /api/saves`,
    `DELETE /api/saves/:listingId`. localStorage remains the mock-mode store
    and the instant-echo cache; live mode hydrates saved ids from the server
    on session load. Trade-off: the heart no longer posts a `save` swipe in
    live mode, so one-tap saves don't update styleTags there (deck saves still
    do via `/api/swipes`); mock mode keeps the swipe for parity.
20. **similarSearch → `POST /api/find-similar`** (multipart `photo` upload —
    the page now sends the actual file — or JSON `{imageUrl|hint}`); the
    `/api/rank` keyword workaround is gone. Descriptor is derived from the
    returned attribute vector.
21. **Real mode is the default** (`NEXT_PUBLIC_API_MOCK` unset;
    `npm run dev` + `npm run seed` is the canonical experience). Mock mode
    still works behind `NEXT_PUBLIC_API_MOCK=1`.

## e2e & tooling

22. **`npm run test:e2e` runs REAL mode**: webServer re-seeds then starts the
    dev server keyless. `npm run test:e2e:mock` is the mock smoke variant
    (same mode-agnostic specs, port 3211). Screenshots are shared — whichever
    ran last wins.
23. **Color-quiz spec answers changed** (`Tans easily` → `Almost never
    burns`) so BOTH scoring tables (packages/ai quiz table and the mock
    layer) deterministically land on dark autumn.
24. **`next build` was already red at the 4-way merge**: it lints
    `app/api/__tests__` and backend's response-probing `any`s failed the
    build. Fixed with an eslint override (`no-explicit-any` off for test
    files) rather than rewriting 30 assertions; also ignored the stale
    `.claude/worktrees/**` copies that root `npm run lint` was scanning.

## §5 doc conflict resolved (formula wins)

25. **ARCHITECTURE.md §5's worked example corrected** to the normative
    formula `r = hemAboveFloor / H_eff`: a 44″ dress → `ankle` on 5'2″
    (r = 0.110) and `mid_calf` on 5'10″ (r = 0.191). Both packages/matching
    and the frontend hem mirror already implemented the formula (their
    decision logs #1/#5); tests + the real API agree end-to-end
    (verified via `/api/rank` hem results for the 5'4″ demo profile).

## Known issues for QA

- Fixture images are placehold.co URLs; in real mode the feed renders gray
  placeholder boxes (mock mode's editorial SVG placeholders only apply to
  `mockimg:` URLs). Cosmetic; real connector data brings real images.
- Live-mode heart-saves don't feed style learning (see #19).
- `test:live` (live-API smoke) remains a stub — no key in this environment.
- Re-ingesting fixtures soft-removes the 8 listings whose seeded
  `lastSeenHoursAgo` exceeds 2×cadence (documented data-eng #14; the demo
  feed still shows 140+).
- The admin trigger's run row aggregates per-connector stats; the pipeline
  also writes its own per-connector `ingest_runs` rows (`fixtures` vs
  `fixture:shopify` ids) — two rows per triggered run, intentional.
