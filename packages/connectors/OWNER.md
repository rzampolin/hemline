# OWNER: data-eng

**Scope:** `SourceConnector` implementations + connector framework
(docs/ARCHITECTURE.md §2, §4.2, §8). Also owns `apps/ingest`.

## Deliverables (in order — doc §10 track A)
1. Fixtures connector *(scaffolded — loader + connector work; refine as needed)*
2. Framework: `framework/registry.ts` (done, trivial), `framework/politeness.ts`
   (per-host ≥1s rate limit, UA `HemlineBot/1.0 (+contact)`), `framework/etag-cache.ts`
   (DB-backed, `sources.etag_json`)
3. Shopify products.json crawler — curate & VERIFY `shopify/stores.json`
   (~40 stores; some disable products.json). Max 1 crawl/day/store.
4. eBay Browse API connector (+ mock mode against `fixtures/ebay-sample.json`,
   visible `[MOCK]` log, stats flagged `mock:true`)
5. Scheduler pipeline in `apps/ingest`

## Contracts you build against (frozen)
`SourceConnector`, `FetchContext`, `FetchResult`, `RawListing`, `EtagCache`,
`Logger` from `@hemline/contracts`. You meet ai-eng only at
`RawListing → ExtractionService`.

## Fixture data
- `src/fixtures/listings.json` — 150 pre-baked demo listings (raw + sizeNormalized
  + freshness offsets + extraction). Seed + tests + zero-key demo depend on it;
  regenerate with `node scripts/generate-fixtures.mjs` (deterministic, seeded).
- `src/fixtures/ebay-sample.json` — mock Browse API `item_summary/search`
  response for eBay mock mode + normalizer unit tests.
