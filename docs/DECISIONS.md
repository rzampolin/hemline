# Scaffold Decisions (week 0)

Pragmatic calls made while scaffolding where docs/ARCHITECTURE.md was ambiguous,
silent, or would not compile as written. Everything else follows the doc.

1. **`ExtractedAttributes` lives in `contracts/src/listing.ts`, not `extraction.ts`.**
   The doc defines it in §4.3 (extraction.ts) but `RawListing.attributeHints`
   (§4.1, listing.ts) references it — with Zod schemas evaluated at module load,
   listing ⇄ extraction becomes a real import cycle (TDZ crash). Defined in
   listing.ts, consumed everywhere via the package root; public API unchanged.

2. **Contracts are Zod-first.** Types are `z.infer` of the schemas rather than
   hand-written interfaces (doc shows interfaces). Shapes are identical; one
   source of truth serves runtime validation + TS types + `zodOutputFormat`.
   Service interfaces (`SourceConnector`, `ExtractionService`, `MatchingService`)
   remain plain interfaces, verbatim from the doc.

3. **Fixture sources are two rows: `fixture:shopify` and `fixture:ebay`** (both
   `kind='fixture'`), so source badges/filters demo realistically. The fixture
   *connector* keeps the doc's id `fixtures`. Pre-baked extractions use
   `extractions.model = 'fixture'` (doc's comment shows examples, not an enum).

4. **Fixture entry shape** (`packages/connectors/src/fixtures/listings.json`):
   `{ raw: RawListing, sizeNormalized, lastSeenHoursAgo, firstSeenDaysAgo, extraction }`.
   - `sizeNormalized` is pre-baked because the real size normalizer (EU/UK/
     vintage) is data-eng week-1 work and the seed must not implement business logic.
   - Freshness is stored as *offsets*; `db:seed` converts to epoch ms at seed
     time so the demo feed always looks fresh (`raw.seenAt` also carries a baked
     generation-time epoch so `RawListingSchema` validates standalone).
   - Generator: `scripts/generate-fixtures.mjs`, seeded PRNG, fully deterministic.

5. **`QuizAnswers` defined minimally** (vein color, jewelry metal, white-vs-cream,
   sun reaction, natural hair, eye color) per §7.4's description — the doc
   references the type in §4.7 without defining it.

6. **`npm run seed` = `db:migrate` + `db:seed`.** The doc only names `db:seed`;
   a single idempotent "make the demo db exist" command was required.
   `db:migrate` = `drizzle-kit push` (per doc §9.2); `packages/db/src/migrations/`
   is reserved for `drizzle-kit generate` output when reviewable migrations matter.

7. **Lint/format: minimal ESLint 9 flat config + typescript-eslint + Prettier**
   (doc says "eslint" but specifies nothing else).

8. **`ebay-sample.json` mimics a Browse API `item_summary/search` response**
   (itemSummaries with price/condition/localizedAspects/seller…) since §9.4
   wants normalizer unit tests against a "recorded" eBay response. data-eng may
   swap in a genuinely recorded capture when eBay keys exist.

9. **Workspace packages ship raw TS** (`main: ./src/index.ts`) — no build step.
   Next consumes them via `transpilePackages`; scripts run via `tsx`; typecheck
   is per-workspace `tsc --noEmit` fanned out from the root.

10. **The fixtures connector + loader are implemented** (trivial JSON read) —
    the seed, tests, and week-1 vertical slice depend on it. eBay/Shopify
    connectors, framework politeness/etag, ingest pipeline, AI services, and
    matching functions are compiling stubs that throw "not yet implemented".

11. **`drizzle.config.ts` does not auto-load `.env`** (drizzle-kit reads only
    `process.env`); it falls back to `./data/hemline.db`. Export `DATABASE_PATH`
    in your shell if you relocate the db.

12. **`user_brand_sizes` seeds 3 rows and the demo user gets hand-tuned
    `styleTags`** (doc §9.3 only says "demo profile + 30 swipes"); real
    styleTags learning from swipes is ai-eng/backend-eng work.
