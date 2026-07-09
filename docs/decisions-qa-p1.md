# Decisions — QA P1 fixes (2026-07-08)

Fixes for the open P1s in docs/QA_REPORT.md (§5 "Open"), pre-deployment.
All contract/schema changes are **additive** (frozen-contracts rule respected).

## 1. Palette-boost toggle is now end-to-end (QA open bug #1, spec D2)

**Decision: persist the toggle on the profile** (`UserProfile.paletteBoostEnabled?: boolean`,
additive optional field), not on `RankRequest`.

- Why the profile: the UI presents it as a **global** setting (profile page
  toggle + feed chip both flip the same switch), spec D2 calls it a global
  boost toggle, and a request-level flag would force every rank call site
  (feed, search, deck, saved rack) to thread it through. On the profile it
  reaches `packages/matching` for free via the existing `loadProfile` port —
  zero port/signature changes.
- Storage: additive `users.palette_boost_enabled INTEGER` column
  (ddl.ts `ADDITIVE_COLUMNS` migration). **NULL = enabled** — legacy rows and
  fresh profiles behave exactly as before the field existed.
- Semantics: `false` neutralizes the boost factor (1.0) inside the score₀
  composition (`packages/matching` matching-service + the rack/find-similar
  `toRankedListings` path). It is a pure re-ordering knob — the result SET is
  identical on/off (spec "never hides" invariant, asserted in unit, API, and
  e2e tests).
- Frontend: the existing toggle now PATCHes `/api/profile` (optimistic;
  localStorage kept as mock-mode/pre-sync fallback). Mock mode keeps its
  client-side boost emulation — parity unchanged.
- Note for ai-eng: `rerankCacheKey` does not hash the new field, but the
  candidate-id ORDER (which the toggle changes) is part of the key, so stale
  cache hits can't mask the toggle. Adding the field to the profile hash is a
  nice-to-have when packages/ai is next open for changes.

## 2. Bounds on PATCH /api/profile numerics (QA open bug #7→P1)

**Decision: additive `BoundedProfilePatchSchema` in contracts** (same wire
shape as the frozen `ProfilePatchSchema`, plus bounds), used by the route.
Rejections use the standard `{ ok:false, error:{ code:'invalid_request' } }`
envelope via the existing `zodFail`.

- Height: 48–84 inches (4′0″–7′0″). Quiz + profile UIs emit 48–83.
- Budget: cents ≥ 0, integer, `min ≤ max` when both present.
- Sizes: each within the normalized US 0–26 domain (quiz emits 0–18).
- Heel: 0–8″ (UI stepper caps at 4″).
- NaN/Infinity can't ride JSON; strings and negatives 400 cleanly (tested).
- The onboarding quiz and profile page were audited: every value they can
  produce sits inside the bounds, so no UI change was needed.

## 3. GBP/USD currency mixing (QA open bug #6→P1)

**Decision: static FX table + compute-at-query USD equivalents; display stays
native.**

- `packages/contracts/src/fx.ts` (additive): `FX_TO_USD` (GBP 1.27, EUR 1.08,
  AUD 0.66, CAD 0.73) + `toUsdCents()`. **Rates are static, approximate
  (July 2026 mid-market) and documented as such** — no network dependency,
  deterministic tests, and ±few-% error is immaterial against a $10-step
  budget slider. **Revisit at scale**: when currency-mixed sources grow or
  monetization makes accuracy matter, replace with a daily-refreshed rate
  source behind the same two exports.
- **No new column** (schema owner FYI): USD equivalents are computed in SQL
  (`CASE currency … END` over the static table) inside `queryCandidates`
  budget predicates and the `metaFilters` price facet, and in TS inside
  `packages/matching` `matchesHardFilters`. At ≤10k rows the CASE is
  negligible and there is nothing to backfill or drift; an indexed
  `price_usd_cents` column via the `ADDITIVE_COLUMNS` pattern is the upgrade
  if the catalog grows beyond SQLite-comfortable scans.
- Convention (documented on `HardFiltersSchema`): `priceMinCents`/
  `priceMaxCents` are **USD cents** (spec §3 budgets are USD-only).
- Display: already native-currency via the shared `formatPrice(cents,
  currency)` in `packages/ui` (QA fixed-bug #5) — audited all render sites
  (product card, detail, swipe deck, landing strip, rack/similar via
  ProductCard). Filter-sheet and budget sliders render "$" correctly because
  they operate on the USD-normalized facet/budget domain.
- Fixture corpus gained one GBP listing (151 total) so currency handling is
  permanently exercised by seed, unit, API, and e2e layers.

## 4. Clickout / attribution log (QA open bug #5, spec G4)

- Additive `clickouts` table: `listing_id`, `user_id` (nullable — guests
  tolerated), `source_id`, `destination_hash`, `clicked_at`.
  **No full-URL/PII at rest**: the destination (`affiliateUrl ?? sourceUrl`)
  is stored as a sha256 hash only; joins for sold-detection/attribution go
  through `listing_id`/`source_id`.
- `POST /api/clickouts { listingId }` (additive route + contract schemas):
  sourceId/destination are derived **server-side** from the listing row so a
  client cannot spoof attribution; unknown listing → standard 404 envelope.
- Frontend: the detail-page "Shop on …" CTA fires `navigator.sendBeacon`
  (fetch-keepalive fallback) — non-blocking, never delays the outbound tab,
  silent on failure, no-op in mock mode.
- Surfacing: `GET /api/admin/ingest` gains an additive `clickouts` field
  (`{ total, last24h, bySource }`) next to source health.
- Deliberately NOT built (out of P1 scope): a redirect service (`/out/:id`),
  dedupe, and per-user click history UI.
