# Hemline — MVP Product Spec

**Owner:** Product | **Status:** Ready for build | **Last updated:** 2026-07-06
**Form factor:** Mobile-first responsive website. No native app, no browser extension in MVP.

---

## 1. Product Thesis & Personas

### Thesis

Women waste hours digging through resale marketplaces and DTC brand sites to find dresses that actually fit — not just their labeled size, but their height, proportions, coloring, and taste. Hemline aggregates in-stock dresses from across the web (eBay + 30–50 Shopify DTC brands at launch), extracts structured attributes (garment length, measurements, color, style) with the Claude API, and personalizes results against a 90-second profile. Our wedge is **effective length**: given her height, we compute where each hem actually falls *on her* and reclassify every dress per user ("This midi hits mid-calf on you"). No competitor does this. We never own checkout — every listing links out via affiliate/source URLs, monetizing from day one.

### Personas

**P1 — Maya, 29, petite (5'2"), resale-leaning.** Design associate in Chicago. Shops Poshmark and eBay for deals but returns half of what she buys because "midi" dresses hit her ankles and vintage sizing is a lottery. Wants: honest hem predictions, measurements over labels, budget filters. She is our **beachhead** — petite (<5'4") users have the sharpest pain and no existing solution.

**P2 — Dana, 38, tall (5'10"), DTC brand shopper.** Marketing director in Austin. Shops Reformation, Staud, and similar brands but "minis" are indecent on her and "maxis" become midis. Sizes vary wildly across brands; she keeps a mental map ("I'm a 6 in J.Crew but an 8 in Reformation"). Wants: length truth, cross-brand size translation, new-arrival alerts in her size. Also beachhead (>5'8").

**P3 — Priya, 33, average height (5'5"), style-first.** Product manager in NYC, shops both resale and DTC. Her pain is discovery and taste-matching, not fit: she wants a feed that "gets" her (colors that flatter her, silhouettes she likes) without hand-tuning ten filters. She validates that the personalization engine (color analysis, swipe calibration, re-ranking) delivers value beyond the fit moat.

---

## 2. MVP Scope — User Stories with Acceptance Criteria

Priority tags: **P0** = demo-critical, **P1** = MVP-complete, **P2** = ship-if-time / fast-follow.

### A. Onboarding & Profile

**A1 (P0) — Visual quiz.** As a new visitor, I can complete a visual onboarding quiz in ≤90 seconds so I get a personalized feed without creating an account.
- ≤8 screens; every screen is tap-first (image tiles, chips, steppers — no free-text except height/size entry).
- Order is hard-constraints-first: (1) height, (2) usual dress size (US numeric + S/M/L toggle), (3) pick 2–3 reference brands from a visual grid and state her size in each ("I'm a 6 in J.Crew"), (4) lengths/coverage to avoid (multi-select: mini, strapless, bodycon, backless, etc.), (5) budget range slider, (6–7) style vibe tiles (optional), (8) done → swipe calibration.
- Persistent progress indicator (e.g., "3 of 8") on every screen.
- Every non-constraint screen has a visible "Skip" affordance; height and size cannot be skipped (they power the moat).
- No account, email, or login required at any point before the first feed.
- Median completion time ≤90s measured via instrumentation.

**A2 (P0) — Local-first profile (decision: no auth in core loop).** As a user, my profile (quiz answers, swipes, palette, saves) persists on this device without me creating an account.
- **Decision:** local-first anonymous profile. On first visit the client generates an anonymous profile ID (UUID) stored in `localStorage`; all profile data is persisted server-side keyed to that ID so ranking runs server-side and nothing is lost on cache-light reloads.
- No password, no OAuth, no signup wall anywhere in the browse/feed/detail loop.
- **Email magic link is the only auth, and it is optional and deferred to the moment of need:** prompted only when the user (a) wants saved items synced across devices or (b) opts into alerts. Magic link merges the anonymous profile into an email-keyed account. (Story F3.)
- Rationale: fastest time-to-first-feed, zero drop-off from auth walls, and we still capture email exactly when the user has a reason to give it. Full accounts/auth is explicitly out of scope (§3).

**A3 (P1) — Editable profile.** As a returning user, I can view and edit everything Hemline knows about me on one settings screen.
- Editable: height, dress size, reference-brand sizes, avoid-list, budget, color palette (view/edit/delete), style preferences.
- Deleting the palette immediately removes the "in your palette" boost and chips from the feed.
- "Reset my profile" clears everything (with confirm).

**A4 (P1) — Progressive profiling.** As a user, Hemline asks me at most one contextual question at a time, in context, never as a form.
- Trigger examples (implement at least 3): bra size prompt when viewing a bustier/strapless dress; hem-preference prompt after lingering on 3+ maxi dresses; "did this brand run small/large for you?" chip on a product card of a brand she declared a size in.
- Rate limit: max 1 prompt per session; every prompt dismissible; answers write to the same profile store.

### B. Search & Feed

**B1 (P0) — Personalized feed.** As a user who finished onboarding, I see a feed of real, in-stock dresses ranked for me.
- Feed assembles live during/after swipe calibration ("building your rack…" state, see E2).
- Hard filters applied silently: her size available, within budget, avoid-list excluded, in-stock (`last_seen_at` within freshness window — 48h for Shopify sources, 24h for eBay).
- Ranking (server-side): base relevance → boosted by swipe-calibration taste vector and Claude re-ranking → soft-boosted by palette match (if palette exists) → listings with parseable garment measurements rank above measurement-less listings (research finding 3).
- Palette boost is **soft and visible**: matching cards show a removable "in your palette" chip; removing it (per-card or globally in settings) removes the boost. Palette never hides or filters out dresses.
- Infinite scroll; each card renders in <200ms after data arrives; feed API p95 <800ms.

**B2 (P0) — Product card.** As a user, every dress card in any feed/grid shows the moat and trust signals at a glance.
- Card contents: image, brand, price, source badge (eBay / brand name), size availability, **effective-length line** ("Hits mid-calf on you" — see C2, mandatory on every card), freshness ("Seen 2h ago" from `last_seen_at`), palette chip when applicable, save (heart) button.
- No card ever ships without the effective-length line; if length is unknown, card shows "Length unverified" (never blank).

**B3 (P1) — Filters & search.** As a user, I can refine the feed with filters and keyword search.
- Filters: effective-length-on-you (mini/knee/midi/maxi *as computed for her*, not label), price, color family, brand, source, size, condition (new/pre-owned).
- Keyword search over title/brand/attributes; search results respect the same hard filters and ranking.
- Filter state reflected in URL (shareable/back-button safe).

**B4 (P1) — "Find dresses like this" photo upload.** As a user, I can upload or paste a photo of any dress (screenshot, street photo) and get visually/attribute-similar in-stock matches.
- Persistent entry point (camera icon in header/nav) — this is a standing feature, **not** an onboarding step.
- Claude vision extracts attributes (silhouette, length, color, neckline, pattern) → attribute query against catalog → results as a standard feed grid with the usual cards.
- Returns results in <8s p95; graceful "no close matches — here's the nearest" fallback.
- Uploaded photos are not stored beyond the analysis request unless the user saves the search.

### C. Product Detail

**C1 (P0) — Detail page.** As a user, I can open any card to a detail page with everything extracted about the dress.
- Contents: image gallery, title, brand, price, sizes in stock, condition, source, **freshness** ("Last seen in stock: 3h ago"), extracted attributes (length class + inches when stated, measurements, fabric, color, neckline), and the effective-length module (C2).
- **Outbound CTA is primary:** "View on [eBay/Brand]" button opens the affiliate-wrapped source URL in a new tab. We never own checkout; there is no cart, no buy button of ours, anywhere.
- Affiliate parameters applied via redirect service so clicks are attributable (G-story tracks them).

**C2 (P0) — Effective length (THE MOAT).** As a user, I see where each dress actually ends on my body, in plain language, everywhere.
- Computation: shoulder-to-floor ≈ 0.82 × user height. Hem position = garment length (inches, extracted from listing measurements when stated; else estimated from length class + brand/category priors) vs. shoulder-to-floor. Map to zones: upper-thigh / mini / above-knee / knee / below-knee / mid-calf / ankle / floor.
- Reclassify per user with explicit copy: "This midi hits **mid-calf** on you" / "This maxi is a **midi** on you."
- Detail page shows a simple vertical body diagram with the hem line marked, plus a confidence tag: "Measured" (inches parsed from listing) vs "Estimated" (class-based).
- Appears on **every product card** (compact line) and every detail page (full module). Non-negotiable for demo.

**C3 (P1) — Fit signal.** As a user, I see size guidance grounded in measurements, not labels.
- When listing measurements are parseable (bust/waist/hip/length), show them and compare against her reference-brand size profile: "Runs small — closer to your J.Crew 8" / "Measurements match your usual 6."
- Vintage/pre-owned listings show a standing caution when only a label size exists: "Vintage sizing often runs 3–4 sizes small — measurements unavailable."
- "Runs small/large" user feedback chip on detail page feeds back into the fit model (progressive profiling A4).

### D. Color Analysis (Claude API, optional, post-first-value)

**D1 (P1) — Selfie color analysis.** As a user, *after* I've seen my first feed, I can optionally upload a selfie to get a personal color analysis.
- Entry points: a dismissible feed card ("Want colors that love you back?") after the first feed session, and settings. **Never** an onboarding step; always skippable; onboarding and feed are fully functional without it.
- Claude vision analyzes skin undertone / hair / eye contrast → returns a season (12-season system) + a palette of ~10 flattering colors + ~5 to de-prioritize.
- Result presented as "Does this look right?" with the ability to adjust season or add/remove individual colors before saving. Editable later in settings (A3).
- Output includes a **shareable season + palette card** (static image/OG-tagged URL) — our organic-growth artifact.
- Selfie is processed for analysis and then deleted; only the derived palette is stored. State this in the UI.

**D2 (P1) — Palette as soft boost.** As a user, my palette influences ranking transparently and reversibly.
- Palette match = ranking boost only (defined in B1). Matching cards carry the removable "in your palette" chip. A global toggle in settings disables the boost. Dresses outside the palette are **never hidden or filtered** — hard requirement.

### E. Swipe Calibration

**E1 (P0) — Swipe deck.** As a new user finishing the quiz, I calibrate my taste by swiping 10–15 real dresses.
- Deck of 10–15 **real, in-stock** dresses pre-filtered by her size and budget from the quiz (never stock photos, never out-of-stock).
- Deck is diversity-sampled across silhouette, length, color, and price so swipes carry signal.
- Right = like, left = pass; tap for a quick detail peek without leaving the deck. Skippable after 5 swipes ("Take me to my rack →").
- Each card already shows the effective-length line (moat visible within the first 2 minutes of product experience).

**E2 (P0) — Live feed assembly.** As a user, I see my feed being built from my swipes so the personalization feels earned.
- "Building your rack…" progress state during/after the deck; swipe signals update the taste vector in near-real-time.
- First feed renders within 10s of the final swipe; total time from landing to first personalized feed <2 min at p50 (§5).

**E3 (P2) — Recalibration.** As a returning user, I can re-run a fresh swipe deck from settings to retune my feed. New deck excludes previously swiped items.

### F. Saved Items & Alerts

**F1 (P0) — Save/heart.** As a user, I can heart any dress from card or detail and view all saves on a "My Rack" screen.
- One-tap save/unsave; saves persist to the anonymous profile (A2), no email required.
- My Rack shows the standard product cards (with freshness + effective length) and flags items whose `last_seen_at` has gone stale: "Possibly sold — last seen 3 days ago."

**F2 (P1) — Saved searches.** As a user, I can save a filter/search combination ("black midi-on-me under $150") for one-tap re-run from My Rack.

**F3 (P1) — Email capture via magic link.** As a user, I can attach my email (magic link, no password) to sync my rack across devices and enable alerts.
- Prompted only in context: on My Rack ("Don't lose your rack — sync it") and when tapping any alert toggle. Never a wall.
- Magic link sign-in merges the anonymous profile into the email account; second-device login restores it.

**F4 (P2 — DEFERRED, email stub only) — Alerts.** As a user with an email attached, I can toggle alerts on a saved item ("price drop / low stock") or saved search ("new matches in your size").
- **MVP ships the stub only:** the toggle UI, preference storage, and a `pending_alerts` table. **No alert emails are sent in MVP.** The toggle shows "Alerts coming soon — you're on the list."
- Actual digest/price-drop emails are a fast-follow; do not build sending infrastructure for the demo.

### G. Admin / Ingestion Visibility

**G1 (P0) — Ingestion dashboard.** As an operator, I can see the health of every catalog source on an internal admin page.
- Per source (eBay Browse API; each Shopify brand crawler): last successful run, items fetched / new / updated / dropped, error count + last error, staleness distribution of `last_seen_at`.
- Simple auth (env-var basic auth is fine); not linked from the consumer app.

**G2 (P0) — Extraction QA view.** As an operator, I can inspect any listing's raw source data next to its Claude-extracted attributes (length inches, measurements, color, style), see the extraction confidence, and manually correct fields.
- Corrections persist and override extraction on re-ingest; correction log kept for prompt-tuning.
- Filterable by "low confidence" and "missing length" so we can eyeball moat quality before demos.

**G3 (P1) — Source & flag management.** As an operator, I can add/pause a Shopify brand (domain + crawl schedule) and toggle feature flags (e.g., the staged Poshmark/Depop query-driven connectors, which ship **flagged off**) without a deploy.

**G4 (P1) — Affiliate click log.** As an operator, I can see outbound click counts per source/brand/listing so we can validate the revenue funnel from day one.

---

## 3. Out of Scope for MVP (explicit)

| Item | Status |
|---|---|
| Native iOS/Android app | Out. Mobile-web only. |
| Browser extension | Out. |
| Checkout, cart, payments, order tracking | Out permanently — we link out. (The Yes died full-stack; we won't.) |
| Pinterest import / board sync | Out. "Find dresses like this" photo upload covers the job. |
| Body scanning / photo-based measurement | Out. Height + reference-brand sizes only. |
| Poshmark / Depop connectors | Built as feature-flagged, query-driven connectors **after** MVP core; flag stays OFF in v1. |
| Affiliate network feeds (Rakuten/CJ etc.) | Staged post-MVP; eBay + Shopify crawler only at launch. |
| Full accounts (passwords, OAuth, social login) | Out. Local-first anonymous profile + optional email magic link only (A2/F3). |
| Alert email sending | Deferred — stub only (F4). |
| Non-dress categories, menswear, kids | Out. |
| Social features (following, comments, sharing racks) | Out, except the shareable palette card (D1). |
| Internationalization / non-USD | Out. US, USD, inches. |

---

## 4. Screen-by-Screen Flow (mobile-first)

1. **Landing.** One screen: value prop headline ("Dresses that actually fit — your size, your height, your colors"), a live strip of real product cards showing effective-length lines as proof, single CTA "Find my dresses →". No nav clutter, no signup. Secondary link: "How it works." Loads <2s on 4G.
2. **Quiz (≤8 screens, progress bar "n of 8").** ① Height (feet/inches picker). ② Usual dress size. ③ Reference brands: tap 2–3 brand logos from a grid → inline size stepper per brand. ④ "Never show me": chips for lengths/coverage to avoid. ⑤ Budget: dual-handle slider with live count of matching in-stock dresses. ⑥–⑦ Style vibe: image-tile multi-select (skippable). ⑧ Transition: "Let's calibrate your taste." Back navigation works; answers autosave to the anonymous profile after each screen.
3. **Swipe calibration.** Full-bleed card deck, 10–15 in-stock dresses in her size/budget. Swipe right/left; heart doubles as save; effective-length line on every card. Progress dots; "Take me to my rack →" appears after 5 swipes. On completion: "Building your rack…" animation (real work: taste vector + ranking) → feed.
4. **Feed ("Your Rack" home).** Two-column card grid; sticky top bar with search field, filter button, and photo-upload ("find dresses like this") camera icon. Cards per B2. Filter sheet slides up (B3). Interstitial slots (max 1 per ~15 cards) carry progressive-profiling questions (A4) and, once per user post-first-session, the color-analysis invite. Bottom nav: Rack (feed) / Saved / Profile.
5. **Product detail.** Swipeable image gallery → title/brand/price/sizes → **effective-length module** (body diagram + "This midi hits mid-calf on you" + Measured/Estimated tag) → fit signal (C3) → attributes → freshness line → sticky bottom CTA "View on Reformation ↗" (affiliate link, new tab). Heart in header. Back returns to scroll position.
6. **Color analysis moment.** Entered from the feed invite card or settings — never mandatory. ① Explainer + privacy note ("We analyze, then delete your photo"). ② Camera/upload. ③ Analyzing state. ④ Result: season name, palette swatches, "Does this look right?" with edit controls. ⑤ Confirm → shareable palette card with native share sheet + "See dresses in your palette" CTA back to feed, where "in your palette" chips now appear.
7. **Profile / settings.** Sections: My Fit (height, sizes, reference brands, avoid list), Budget, My Colors (palette view/edit/delete, boost toggle), Taste (re-run swipe deck — E3), Account (email status, magic-link connect, sync state), Reset profile. Everything editable; edits re-rank the feed on next load.

---

## 5. MVP Success Metrics

| Metric | Target | Notes |
|---|---|---|
| Time to first personalized feed (landing → feed rendered) | < 2 min p50, < 3 min p75 | North-star onboarding metric |
| Quiz completion rate (started → finished) | ≥ 70% | Drop-off instrumented per screen |
| Swipe calibration engagement | ≥ 10 swipes median | |
| Effective-length coverage | ≥ 85% of feed cards show a Measured or Estimated hem line; ≥ 40% Measured | Moat quality — tracked in admin G2 |
| First-session saves | ≥ 3 hearts median per completed onboarding | Taste-match proxy |
| Outbound affiliate CTR | ≥ 8% of detail views click out | Revenue funnel (G4) |
| D7 return rate (same device or synced) | ≥ 20% | |
| Color analysis opt-in (among users who see the invite) | ≥ 25%; ≥ 10% of completers share the palette card | |
| Catalog freshness | ≥ 95% of surfaced listings `last_seen_at` < 48h | Admin G1 |
| Feed API latency | p95 < 800ms | |

---

## 6. Prioritization Summary

**P0 — demo-critical (the demo is: land → quiz → swipe → feed → detail with effective length → click out):**
A1 quiz · A2 local-first profile · B1 feed · B2 product card · C1 detail + affiliate link-out · C2 effective length · E1 swipe deck · E2 live assembly · F1 saves · G1 ingestion dashboard · G2 extraction QA.

**P1 — MVP-complete:**
A3 editable profile · A4 progressive profiling · B3 filters/search · B4 photo upload ("find dresses like this") · C3 fit signal · D1 color analysis · D2 palette boost · F2 saved searches · F3 magic-link email capture · G3 source/flag management · G4 click log.

**P2 — ship-if-time / fast-follow:**
E3 recalibration · F4 alerts (stub UI in P1 surface, sending deferred).

---

*Engineering notes: all AI extraction/re-ranking/vision via Claude API; connector framework must treat eBay Browse API and the Shopify products.json crawler as two implementations of one source interface so affiliate feeds and Poshmark/Depop slot in behind flags later. Effective-length computation is pure and deterministic given (garment_length_inches | length_class, user_height) — unit-test it hard; it's the demo.*
