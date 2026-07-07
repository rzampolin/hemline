# QA Report — 2026-07-06

**QA:** full pass over cold-start, live ingest (3 real Shopify stores), spec-conformance
(Playwright, 390×844 + 320px), adversarial API poking, final gate.
Oracle: docs/PRODUCT_SPEC.md; hem math: docs/ARCHITECTURE.md §5.
The four known issues in docs/decisions-integration.md are excluded per brief.

## 1. Cold start — PASS

`rm -f data/hemline.db*` → `npm run seed` (150 listings, 373 images, 150 extractions,
2 sources, demo user) → `npm run dev` ready in ~1.1s → `GET /` 200 in ~2s. Zero friction.

## 2. Live ingest (keyless, mock extractor) — PASS after fixes

`npm run ingest -- --source=shopify --store=<domain>`, sequential, polite (1 req/s,
ETag cache, HemlineBot UA). All three verified stores ingested cleanly, extraction
queue drained, `GET /api/admin/ingest` reflects every run.

| Store | Dresses | Hem class coverage | Measured inches | Colors | Sizes normalized | Real images |
|---|---|---|---|---|---|---|
| staud.clothing (8 pages) | 436 | 64.7% | 0% | 46.3% | 98.4% | 100% |
| christydawn.com (2 pages) | 215 | 74.0% | 0% | 22.8% | 80.5% | 100% |
| sisterjane.com (6 pages) | 552 | 96.9% | 0% | 31.5% | 99.1% | 100% |
| **Weighted (1,203 live)** | | **81.3%** | **0%** | **35.3%** | **96.1%** | **100%** |

Honest read for the founder: keyless live data gets an **Estimated** hem badge on ~81%
of listings (near the ≥85% target; coverage figures above are after my extractor fix,
up from 49–88% before). **Measured is 0%** — DTC product copy almost never states
garment length in inches (14/1203 listings had any inch-like pattern), so the ≥40%
Measured target is unreachable without the Haiku image pass (needs ANTHROPIC_API_KEY)
or per-brand size-chart scraping. Color coverage 35% comes from title/description
keywords only. Feed verified in-browser: real Shopify CDN images render (12/12 first
cards, 0 broken), hem badges on every card, freshness + source badges, link-out CTA
opens the correct product URL in a new tab.

**Caveat:** e2e runs re-seed the db (fixtures only). Re-run the three ingest commands
before a live-data demo (~40s total; idempotent).

## 3. Spec-conformance walkthrough (e2e/qa.spec.ts — 9 specs, both modes green)

| Area | Verdict | Notes |
|---|---|---|
| A1 quiz | PASS | 8 screens, "n of 8" on every screen, height/size gated, Skip on 3–7, back-nav preserves answers, no account wall, automated happy path ≪ 2 min |
| A2 local-first profile | PASS | cookie session + server profile; no wall anywhere |
| A3 editable profile | PASS | height edit re-computes hem on detail (regression test in suite) |
| **C2 effective length (MOAT)** | **PASS** | petite 4'11" vs tall 6'0": same dress, different badge on card AND detail; diagram renders; 3 listings × 2 heights hand-computed against §5 — exact match |
| E1/E2 swipe deck | PASS | deck of 12 (10–15 ✓), like/pass advance, skippable after 5, "building" state → feed |
| B1/B2 feed cards | PASS | every card: hem badge or "Length unverified" (never blank), source badge, freshness, price |
| B3 filters | PASS | size+price+length-on-you+source in URL (`sizes=8&len=knee&src=brand`), survive reload, hem filter honors *on-you* position; empty state graceful with working "Clear filters" |
| D1 color quiz fallback | PASS | quiz → Dark Autumn → confirm → palette card → chips on feed |
| D2 palette never hides | PASS | full-pagination id set identical with palette on vs off (112 = 112, order differs) |
| D2 global boost toggle | **FAIL** | see Open bug #1 |
| F1 rack | PASS (after fix #6) | save → appears; unsave → gone; stale save shows "Possibly sold — last seen …" |
| C1/C3 detail | PASS | measurements table when present, vintage caution when measurement-less vintage, CTA href = affiliateUrl ?? sourceUrl, `target=_blank rel=noopener` |
| A4 progressive profiling | **MISSING** | Open #2 |
| F2 saved searches | **MISSING** | Open #3 |
| G1/G2 admin | PARTIAL | JSON APIs work (incl. `?missing=length&lowConfidence` filters); no admin *page* UI (Open #4) |
| G4 click log | **MISSING** | Open #5 |
| 320px viewport | PASS | zero horizontal overflow on landing + feed; long brands truncate |

## 4. Adversarial — PASS across the board

- Heights 0/999/−5, negative budget: accepted (see Open #7) but **no crash**; hem math
  degrades to null safely; type junk → clean Zod 400s; malformed JSON → 400.
- Session cookie tampering (uuid swap, sig swap, garbage, empty): always 401, never 500.
- XSS in brand-size strings: stored, but React-escaped on render — no dialog, no script
  element, literal text only.
- Double-submit save: idempotent (1 row); save of nonexistent listing → 404.
- 10 concurrent swipe POSTs: all 200, style vector consistent (WAL).
- Cursor pagination: 6 pages → 112/112 unique ids, no dupes/skips; tampered cursor →
  clean empty page, negative limit → 400.
- Selfie abuse: junk base64 / non-image bytes → `invalid_image` 400; 12MB JSON and
  multipart → 10MB-cap 400s.

## 5. Bugs

### Fixed in this pass (committed)

1. **P0 — live listings never reached the feed.** Ingest never wrote
   `size_normalized_json` (always `[]`) and the SQL size filter required a match, so the
   profile's silent size filter excluded *every* live listing (feed showed fixtures
   only). Fix: new `packages/db/src/size-normalize.ts` (fixture-convention label→US
   numeric normalizer) wired into pipeline insert/update + backfill; SQL size filter now
   treats size-unknown as pass (aligns with `packages/matching` filters.ts rule 3
   "unknown ≠ no"). Tests added.
2. **P1 — extraction queue misreported "0 pending" past the 500 cap** (Sister Jane:
   552 fetched, 500 extracted, 52 silently deferred). Fix: pipeline drains in batches
   with a zero-progress guard; pending count now honest.
3. **P1 — mock extractor missed "ankle length" DTC copy** (69 unclassified live
   listings, dominant Christy Dawn phrasing). Fix: taxonomy keyword → `maxi`.
   Coverage lift: CD 49→74%, SJ 88→97%, STAUD 61→65%.
4. **P1 — literal `<b>` markup rendered in feed titles** (288 Sister Jane listings).
   Fix: `stripHtml` on Shopify title/vendor in the connector normalizer.
5. **P1 — GBP prices displayed as "$69"**. Fix: `formatPrice(cents, currency)` with
   symbol map, applied at all call sites (card, detail, deck, landing strip).
6. **P1 — unsave race on My Rack**: card lingered after unsave (fire-and-forget DELETE
   vs instant refetch). Fix: saved page filters by client-truth `savedIds`.

### Open (filed, not fixed)

1. **P1 — D2 global palette-boost toggle is cosmetic in live mode.** It hides chips
   (localStorage) but `/api/rank` still applies the server-side boost whenever
   `profile.palette` is non-empty; spec D2 says the toggle "disables the boost". Needs
   an additive `RankRequest.paletteBoost?: boolean` (or profile field) + route wiring.
   Repro: save a palette, toggle off in settings, POST /api/rank — ordering still
   boosted. Owner: backend-eng + contracts. (Never-hides invariant does hold.)
2. **P1 — A4 progressive profiling not implemented** (no interstitial prompts, no
   triggers). Owner: frontend-eng.
3. **P1 — F2 saved searches not implemented.** Owner: frontend-eng (+ small API).
4. **P1 — G1/G2 have no admin UI page** — JSON endpoints only; spec wants an internal
   page with correction editing (corrections API exists). Owner: frontend-eng.
5. **P1 — G4 click log / affiliate redirect service missing**: detail CTA links
   directly to `sourceUrl`; no click attribution row is written anywhere, so the
   revenue funnel is unmeasurable. Owner: backend-eng.
6. **P2 — currency mixing**: GBP stores (Sister Jane, RIXO, KITRI…) store pence in
   `price_cents` and are filtered/sorted against USD budgets 1:1 (spec §3 says
   USD-only). Either FX-convert at ingest or de-verify GBP stores. Owner:
   data-eng/product call.
7. **P2 — no bounds on profile numerics**: PATCH /api/profile accepts
   `heightInches: 0/999/-5`, negative budget (no crash; hem→null). Clamp server-side
   (contract is frozen; route-level clamp is additive). Owner: backend-eng.
8. **P2 — Shopify size-option detection** occasionally ingests color/style variant
   options as size labels (Sister Jane `"Blue, Black"`, `"Z"`, `"MP"`). Junk labels now
   normalize to nothing (safe), but detection heuristics could check option name.
   Owner: data-eng.
9. **P2 — `RankRequest.userId` is required but ignored** when a session cookie exists;
   confusing for API consumers. Additive: make optional. Owner: contracts.
10. **P3 — no `onError` fallback for broken product images** (browser broken-image
    glyph in the card). Cosmetic. Owner: frontend-eng.

Note: F3 magic-link is a stub by documented architecture decision (auth deferred), not
counted as a bug.

## 6. Final gate

`npm run typecheck` ✅ · `npm test` 299/299 (293 + 6 new) ✅ · `npm run build` ✅ ·
`npm run test:e2e` (real, 11 specs) ✅ · `npm run test:e2e:mock` (10 + 1 skip) ✅.
Screenshots: `e2e/screenshots/qa/`.

## 7. Demo-readiness verdict

**GO for the scripted P0 demo** (land → quiz → swipe → feed → detail with effective
length → click out): every P0 story passes, the moat is verified end-to-end against the
§5 formula, cold start is frictionless, and the app is robust to abuse. **Live keyless
data is genuinely demoable after this pass** (1,203 real dresses, real images, ~81%
hem-badged) — run the three ingest commands post-seed first. Gaps to disclose if asked:
palette-boost toggle (cosmetic), no admin UI page, no click attribution (G4), Measured
hem coverage requires an API key.
