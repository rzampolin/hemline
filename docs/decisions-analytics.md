# Decisions: first-party product analytics (2026-07-09)

Lightweight, privacy-light instrumentation so we know what early users
actually do — what they search, which filters they touch, how far they swipe,
and where onboarding loses them. Built to measure the PRODUCT_SPEC §5 success
metrics (quiz completion ≥70%, ≥10 swipes median, per-screen drop-off,
color-analysis opt-in, catalog gaps). No third parties, ever.

## Architecture

- **Table**: `analytics_events` (additive; drizzle `schema.ts` + `ddl.ts`) —
  `id, user_id (nullable), anon_id, event_type, props_json, created_at`,
  indexed on `(event_type, created_at)`. Timestamps are server-assigned at
  insert (client clocks aren't trusted; flush latency ≤10s is fine at this
  granularity).
- **Ingest**: `POST /api/events` — batched array, sendBeacon-compatible
  (plain-text JSON framing, exactly like clickouts), guest-tolerant, silent
  `204` on success. Zod-validates against a **closed whitelist**
  (`@hemline/contracts` `AnalyticsEventSchema`): unknown event types, unknown
  or extra props, out-of-range values, batches >25 events, and bodies >32KB
  are all rejected. There is deliberately no open-ended `track(anything)`
  channel — adding an event means a contracts PR. Excess traffic beyond the
  per-client rate budget is *dropped silently* (still 204): analytics must
  never become a visible error or a retry storm.
- **Client**: `apps/web/lib/analytics.ts` — one tiny `track(event)` helper
  (typed against the whitelist), in-memory queue, flush on 10s interval /
  batch-cap / `pagehide` + `visibilitychange` via sendBeacon. Fire-and-forget:
  SSR-safe, never throws, never blocks UX, no-op in mock mode.
- **Read side**: `GET /api/admin/analytics` (HTTP Basic like all `/api/admin/*`)
  returns 24h and 7d windows of plain-SQL aggregates: onboarding funnel
  (distinct-actor started→completed rate, per-step drop-off, median quiz
  duration), top-20 search queries with result counts + zero-result flags,
  filter-usage histogram, swipe like-rate.

## Event catalog (the complete whitelist)

| Event | Props | Measures |
|---|---|---|
| `quiz_started` | — | onboarding funnel top |
| `quiz_step_completed` | `step` (1–8) | per-screen drop-off (spec §5) |
| `quiz_completed` | `durationMs` (capped 2h) | completion rate, time-to-first-feed proxy |
| `deck_swipe` | `verdict` (like/dislike/save), `index` | swipe engagement (≥10 median), like-rate |
| `deck_completed` | — | calibration completion |
| `feed_viewed` | `page` (0-based) | feed depth / infinite-scroll reach |
| `search_submitted` | `query` (≤120 chars), `interpreted` (bool), `resultCount` | top queries; **zero-result queries = catalog gaps** |
| `filter_applied` | `kind` (size/price/length/color/brand/source/condition) | which facets earn their pixels |
| `listing_viewed` | `source` (catalog source id) | detail views; denominator for outbound CTR (with clickouts) |
| `listing_saved` | `context` (feed/calibration/search) | first-session saves (spec §5 ≥3 hearts) |
| `listing_unsaved` | — | save churn |
| `color_analysis_started` | `method` (selfie/quiz) | opt-in rate (spec §5 ≥25%) |
| `color_analysis_completed` | `method` | analysis completion |

## What we deliberately do NOT collect

- **No page-by-page browsing trails tied to identity.** There is no generic
  `page_viewed {path}` event and no referrer/URL capture. `feed_viewed` counts
  a page *number*, not what was on it; `listing_viewed` records the catalog
  source, not the listing id — we intentionally cannot reconstruct "user X
  looked at these 14 specific dresses in this order" from this table.
  (Taste-relevant per-listing signals already live in `swipe_events`/`saves`
  where the user explicitly acted.)
- **No third parties.** No GA/Mixpanel/Segment/pixels. Data never leaves our
  SQLite file.
- **No PII and no device fingerprinting.** No IPs, no user agents, no screen
  sizes, no emails. Props are enums and small integers by schema; free text a
  user typed is never stored — with one exception, below.
- **No client timestamps, no client-controlled event names.**

### The search-query exception

`search_submitted.query` stores the raw query text (≤120 chars). That IS
user-typed free text — and it's the point: zero-result searches are the
catalog-gap goldmine ("taffeta ballgown, 0 results, 9 times this week" tells
us exactly what to ingest next). Mitigations: queries are the *only* free
text; the admin view aggregates them (grouped, counted), and the linkage
caveat below applies.

## user_id linkage policy (the honest part)

**Decision: we DO store `user_id` on events when a valid session accompanies
the beacon, and `anon_id` (a per-browsing-session random uuid, sessionStorage)
always.** Guests without sessions are recorded with `anon_id` only; a session
UUID that doesn't correspond to an existing users row is ignored rather than
adopted (no fabricated users, same rule as clickouts).

Why linked at all: the funnel is the product question. "Quiz started →
completed" is only meaningful deduplicated per person
(`COALESCE(user_id, anon_id)`), and `anon_id` alone dies with the browsing
session — a user who starts the quiz today and finishes tomorrow would count
as a drop-off *and* an orphan completion. `user_id` is our own anonymous
first-visit uuid (no account, no email), so linking events to it adds no new
identity information — it links behavior to a pseudonym we already hold.

What this honestly means: search queries are therefore *not* stored unlinked —
a row can say "pseudonymous user X searched 'red midi'". We considered
nulling `user_id` on `search_submitted` specifically, and chose not to for
v1: the same linkage already exists for swipes and saves, the dataset never
leaves our disk, and pretending queries are anonymous while `anon_id` +
timestamps sit beside them would be privacy theater, not privacy. The
admin endpoint only ever exposes aggregates (grouped queries with counts —
no per-user drill-down exists anywhere in the API).

Revisit triggers: real accounts/emails ever attach to `users` rows (then
queries must be delinked or aged out), or a data-retention pass (a 90-day
`analytics_events` TTL sweep is the natural companion and trivially additive).

## Ops notes

- The `/admin` dashboard (parallel workstream) consumes
  `GET /api/admin/analytics` defensively; this side only guarantees the
  `AdminAnalyticsResponse` shape in contracts.
- Inserts are one multi-row statement per batch on the existing single
  better-sqlite3 connection — worst case (cap 25 events × 30 batches/min/client)
  is negligible next to feed queries.
- Tests: `packages/db/src/query/analytics.test.ts` (aggregates against seeded
  events), `apps/web/app/api/__tests__/analytics.test.ts` (whitelist, batch
  caps, junk props, guests, admin auth).
