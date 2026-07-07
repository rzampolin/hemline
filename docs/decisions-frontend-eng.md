# Frontend Decisions (frontend-eng)

Pragmatic calls made building `apps/web` (pages), `packages/ui`, and `e2e`
where PRODUCT_SPEC / ARCHITECTURE were ambiguous or silent. Contract friction
that needs architect/backend attention is flagged **[CONTRACT]**.

## Mock layer & API client

1. **`lib/api.ts` is the single API seam.** Every call is typed with
   `@hemline/contracts` request/response shapes. `NEXT_PUBLIC_API_MOCK=1`
   routes to a client-side mock (`lib/mock/`); unset routes to real fetches
   against `app/api/*` with the `ApiResponse` envelope. Nothing else in the
   app knows which mode it's in.

2. **Mock dataset is derived, not invented.**
   `apps/web/scripts/derive-mock-listings.mjs` reads
   `packages/connectors/src/fixtures/listings.json` (the canonical 150-listing
   corpus) and emits `lib/mock/mock-listings.json` (committed). Freshness is
   stored as offsets and converted to epoch ms at module load so "Seen 2h ago"
   always looks live. Re-run the script if data-eng regenerates fixtures.

3. **Mock runs fully client-side** (profile in `localStorage`, catalog in the
   bundle). Consequence: data-driven pages are client components. That's the
   right shape anyway — in live mode the same components fetch the same typed
   client; server components would buy nothing until a session cookie exists.

4. **Placeholder imagery.** Fixture images are placehold.co gray boxes; the
   derive script rewrites them to a `mockimg:` scheme and `lib/img.ts` renders
   inline-SVG editorial placeholders — gradient from the dress's extracted
   colors, skirt length matching its `lengthClass`, brand in serif. Offline,
   deterministic for e2e, and the demo reads as a designed lookbook. Real
   http(s) URLs pass through untouched, so integration needs no change.

5. **Hem math mirror.** `lib/hem.ts` reimplements ARCHITECTURE §5 (pure, unit
   tested in `lib/hem.test.ts`) because `packages/matching` is a stub and
   off-limits to me. It is used **only** by the mock layer + landing-strip
   height toggle + detail "similar" cards; in live mode hem always comes from
   the server (`RankedListing.hem`, detail response). Note: §5's prose example
   ("44″ classifies mid_calf on 5'2″, r=0.135") doesn't match its own formula
   (r=0.110 → ankle); I follow the formula/band table, matching-eng should
   confirm the same reading.

## Contract friction — flagged for architect [CONTRACT]

6. **No source facet in `HardFilters`**, but PRODUCT_SPEC B3 requires a
   source filter (resale/brand). The client sends an optional
   `filters.sources?: ('resale'|'brand')[]` extension in mock mode and strips
   it in live mode. Proposal: add `sources?: string[]` to `HardFiltersSchema`.

7. **No endpoint to list saved items** (F1 "My Rack"). Saves are *recorded*
   via `POST /api/swipes` verdict `'save'`, but nothing reads them back.
   Interim: saved ids live client-side (`localStorage`) and My Rack hydrates
   each via `GET /api/listings/:id` — works identically in both modes, but a
   cross-device rack (F3) will need `GET /api/saves` or saves on `UserProfile`.
   Also: there is no un-save verdict; unsaving is client-side only.

8. **No endpoint for B4 "find dresses like this"** (photo/URL → similar).
   Mocked with deterministic attribute-vector similarity; live mode falls back
   to a keyword rank. Proposal: `POST /api/similar` multipart
   `{ photo | url }` → `RankResponse`-shaped result + inferred attributes.

9. **`ListingDetailResponse` has no `whyItWorks`** (C1 wants it on detail).
   The detail page composes the line client-side from profile + hem + palette.
   Fine for MVP; would be better served by the re-rank service.

## Product interpretation

10. **Quiz avoid-list mapping (screen 4).** Length avoidances → complement
    stored in `lengthPrefs` (contract holds *preferred* positions); coverage
    avoidances (strapless/plunging/backless) → `coveragePrefs` booleans;
    'bodycon' has no contract slot and is kept in local state only. Raw chip
    selection also persists to `localStorage` for editing fidelity.

11. **Quiz screens 6–7** are style vibes + occasions; both seed
    `profile.styleTags` (`vibe:*` at 1.0, `occasion:*` at 0.7) using the
    fixture attribute-vector vocabulary, so the deterministic ranker picks
    them up before any swipes.

12. **S/M/L toggle** maps XS→[0,2] S→[4,6] M→[8,10] L→[12,14] XL→[16,18] into
    `sizesNormalized` (multi-select allowed in both modes).

13. **Search lives at `/feed?q=…`**, not a separate `/search` route (OWNER.md
    route map showed `app/search/**`). Filters and query are fully
    URL-reflected (B3 shareable/back-button requirement), so a distinct route
    added nothing.

14. **Swipe → styleTags learning (mock)**: like +0.35·w, save +0.5·w,
    dislike −0.3·w per attribute-vector entry, clamped [−1.5, 3]. Deterministic
    ranking = 0.5 + 0.5·cosine, ×1.2 palette boost (soft), ×1.06 measured-
    length boost, × freshness decay (half-life 7d resale / 21d brand) — §6's
    deterministic path.

15. **Palette boost toggle + per-card dismissals are client-side prefs**
    (`localStorage`), honored by the mock ranker. Contract has no place for
    them; live mode will need either a profile field or a rank flag. The
    "in your palette" chip is computed client-side (palette hex → color family
    vs listing color families) since `RankedListing` carries no palette-match
    flag. [CONTRACT — nice-to-have: `paletteMatch: boolean` on RankedListing.]

16. **Color analysis in mock** returns a deterministic season from a hash of
    the selfie file (name+size) — stable for tests, varied for demos; 1 in 5
    results carries the low-quality caveat so the quiz-fallback path is
    demoable. The quiz fallback scores warm/cool + depth + brightness
    deterministically (no LLM), matching §7.4's degraded path.

17. **Alerts (F4) and magic-link (F3) are UI stubs** per spec: toggle persists
    locally and shows "coming soon"; no `pending_alerts` write from the client
    (backend owns that table).

18. **Tailwind v4 needs `@source '../../../packages/ui/src'`** in
    `globals.css` — v4 auto-detection scans from the app's cwd and misses
    workspace packages (classes only used in `packages/ui` silently vanish;
    cost me one debugging session — the filter sheet rendered unstyled).

19. **`packages/ui` depends on `@hemline/contracts`** (types only) so
    `ProductCard`/`HemBadge`/`HemIndicator` take `Listing`/`HemResult`
    directly. It stays free of next/react-dom/db. `ProductCard` accepts a
    `LinkComponent` prop so the app injects `next/link` without ui importing it.

20. **e2e runs in mock mode** (`NEXT_PUBLIC_API_MOCK=1`, port 3210), not
    against the seeded DB — backend routes are stubs in this worktree. Specs:
    happy path (landing → quiz → swipe → feed w/ hem badges → filters →
    detail → save → rack) and color-quiz fallback (→ palette → boost chip →
    profile). When backend lands, a second config/project pointing at the
    seeded server can reuse the same specs. Screenshots are written to
    `e2e/screenshots/` (committed).
