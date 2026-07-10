# Decisions: calibration deck — image resilience + adaptive completion (2026-07-10)

Two founder reports against the onboarding swipe deck: (1) intermittent gray
cards, (2) a user who likes only 2 dresses "completes" calibration with a
nearly-empty style vector. Both fixed in `apps/web` (calibrate page +
`lib/deck.ts` + `lib/img.ts`), additively at every contract boundary.

## 1. Gray cards — root cause (investigated, honest findings)

Sampled the live catalog (a `/tmp` COPY of `data/hemline.db`; the live file was
never touched) and curled real image URLs:

- **The primary cause is not network failure.** The live catalog contains
  **150 fixture listings** (`fixture:ebay` 65, `fixture:shopify` 85) whose 373
  images are literal `placehold.co/600x800` **gray boxes**. They return
  HTTP 200 (`image/svg+xml`), so no `onError` ever fires — the card "works"
  and is gray. Because the deck sampler round-robins across *sources*, the two
  fixture sources get a turn like any real store: a 12-card deck over the
  6-source catalog deals **~2 cards per fixture source per deck** whenever
  fixtures survive the size/budget filter. That is exactly "intermittent gray
  screens".
- Curl sweep of 80 random `listing_images` URLs across all hosts
  (cdn.shopify.com, media.thereformation.com, placehold.co): **all 200**, and
  a 12-request parallel burst against placehold.co showed no rate-limiting
  from this network. So dead-CDN links are not currently measurable from dev;
  transient prod failures (mobile networks, CDN hiccups, future link rot)
  remain plausible — hence the new `deck_image_error` telemetry to measure the
  real prod scale.
- Secondary weaknesses that turn any transient failure into a dead card: the
  deck `<img>` had **no onError, no timeout, no skeleton**, and 457 listings
  (including all 431 Reformation ones) have only a single image — no position
  to fall back to.
- **Recommended follow-up (data eng, not done here):** purge or flag the 150
  fixture listings in the prod catalog; they also appear in the feed/detail
  surfaces, which still render placehold.co directly.

## 2. Image fallback design (`calibrate/page.tsx` CardImage)

Ordered fallback chain per card, always ending somewhere renderable:

1. Gallery images in position order. Known placeholder URLs
   (`isPlaceholderImage`, lib/img.ts) are rewritten **client-side** to an
   editorial inline-SVG placeholder built from the listing's real extracted
   colors / lengthClass / brand (`editorialPlaceholder` — same visual language
   as mock mode's `mockimg:` scheme). This kills the fixture gray boxes in
   both prod and the e2e seed DB without touching data.
2. `onError` **or a 5s stall** (slow-load timeout, active card only) advances
   to the listing's next gallery image and emits
   `deck_image_error {position}`.
3. All real images exhausted → a synthetic editorial placeholder renders
   (never a dead card) **and** the parent seamlessly swaps the card for a
   spare candidate. Spares: the initial sample draws `DECK_SIZE + 4`; the 4
   extras are reserved swaps. Spare swap only happens for cards not yet swiped
   past; with no spares left, the editorial placeholder stands.
4. Perceived speed: the next 3 cards' first images are warmed via
   `new Image().src` while the current card shows; a branded shimmer
   (`Skeleton`, parchment tones) covers loading — never flat gray.

Telemetry: `deck_image_error {position: 0–19}` added to the closed whitelist
(`@hemline/contracts` analytics.ts). `position` is the image's index within
the listing gallery: position-0 errors = primary CDN entry dead; higher =
fallback chain exercised. Only real network fetches emit it (data-URI
placeholders can't fail). No route changes needed — POST /api/events is
schema-driven.

## 3. Adaptive completion — 2 likes is not a style

Completion is now driven by **positive signal**, not card count
(`lib/deck.ts`, pure + unit-tested):

- **Like target 5** (`DECK_LIKE_TARGET`): likes + saves. Hitting it finishes
  the deck immediately (reason `target`).
- **Hard cap 30 cards** (`DECK_CARD_CAP`): never trap the user. Batches: 12
  initial + extensions of `min(7, 30 − seen)` → 12/7/7/4. At the cap with <5
  likes we proceed gracefully (reason `cap`) with honest copy: *"We'll keep
  learning as you browse — every like and save sharpens your picks."* (true —
  feed swipes keep training the taste vector).
- **Extension batches** (6–8 cards, reason to exist: harvest signal): between
  batches an encouraging interstitial (*"Still learning your style — a few
  more"*, editorial voice, never blaming) offers the next batch via a button
  (`deck-more`). Batch sampling excludes attribute values with
  **≥2 dislikes and 0 likes** (silhouette + primary color family —
  `deriveExclusions`) and biases toward **unexplored** silhouettes/combos by
  pre-seeding the sampler's seen-sets (`exploredAttributes`).
  - *Patterns* are not excludable: `pattern` isn't a field on the client
    `Listing` shape (it lives in the server-side attribute vector), so v1
    exclusion covers silhouettes + color families. Additive follow-up if
    pattern ever surfaces on the contract.
  - Exclusion is **SOFT**: if the filtered pool can't fill the batch, excluded
    items top it up — a thin catalog must not starve the deck.
- **Sampling stays client-side** (status quo): the deck has no dedicated
  route; `/api/rank` supplies a 48-candidate pool and `sampleDeck` runs in the
  browser. `sampleDeck(items, n, options?)` gained additive
  `{ exclude, explored }` options; no server change was needed, so none was
  made. If the pool ever moves server-side, the same options map 1:1 onto
  request params.
- **Progress = likes-toward-target**: hearts filling ("3 of 5",
  `HeartsProgress` in @hemline/ui), not raw card count. The "n / N" card
  counter stays (spec E1 asserts deck size 10–15 via it).
- **Skip path unchanged**: "Take me to my rack →" still appears after 5
  swipes (reason `skip`). Pool exhausted mid-extension → reason `exhausted`,
  same graceful finish.

Analytics (all additive on the closed whitelist): `deck_swipe` gained optional
`batch` (0-based); `deck_completed` gained optional `likes`, `cardsSeen`,
`reason` (`target|cap|skip|exhausted`). Old empty payloads remain valid.

## 4. Guarded flows

- **Mock mode**: unchanged code path — mock catalog images are `mockimg:` data
  URIs (can't fail); adaptive logic is data-source-agnostic.
- **Re-run deck from profile**: still filters previously-swiped ids from
  localStorage before sampling.
- **e2e**: `happy-path.spec.ts` / `qa.spec.ts` onboarding helpers updated —
  their 6-swipe sequences reach 5 positives, which now auto-finishes (the
  explicit `deck-done` click is exercised by the E1 qa test's 4-positive
  path). New `e2e/calibration.spec.ts`: ≥5-likes auto-completion, and the
  full fallback walk (all passes → 3 interstitials → cap at 30 → graceful
  "keep learning" finish), plus hearts-progress assertions. Screenshots
  12–14 in e2e/screenshots/.
