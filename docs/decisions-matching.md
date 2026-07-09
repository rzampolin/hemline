# Matching / ranking decisions

Owner: matching/backend-eng. Companion to docs/ARCHITECTURE.md §6 and
docs/decisions-backend-eng.md.

## 1. Brand/source monoculture fix (2026-07-09)

**Symptom (founder-reported, prod):** feed and swipe deck show near-identical
brands after a big sequential crawl (petalandpup landed 2,480 listings in one
hour and became the whole feed).

**Verified mechanism:** `queryCandidates` (packages/db) selected candidates
with `ORDER BY last_seen_at DESC LIMIT 500`. Because connectors crawl stores
sequentially and bump `last_seen_at` per sighting, "newest 500" degenerates to
"the last store crawled". Reproduced on the local db: the newest-500 window
contained only 2 of 6 live sources (431 Reformation + 69 Sister Jane; staud
436, christydawn 215 and both fixtures entirely absent). Every downstream
consumer — feed rank, search default order, find-similar pool, the deck's
48-item fetch — drew from that monochrome pool, so the deck's
length/silhouette/color sampling couldn't help.

**Fix, three layers (all shipped together):**

### 1a. Stratified candidate pool (SQL + in-memory)

`stratifiedCap` (packages/matching/src/filters.ts, generic over
`{id, sourceId, brand, lastSeenAt}`) replaces the plain newest-500 slice when
matches exceed the cap:

- **Source-fair first:** round k admits the k-th pick of every source before
  any source gets its (k+1)-th. Each active source gets an equal share of the
  500 pool, up to its size.
- **Brand-spread within source:** a source's share is consumed breadth-first
  across its brands (freshest-first within a brand).
- Result is returned **newest-first** — the pre-fix ordering contract for all
  callers is unchanged; only *which* rows survive the cap changes, and only
  when matches > cap. Freshness decay in scoring still differentiates inside
  the pool.

**Why source-first, not flat per-brand strata:** we prototyped flat
(source, brand) strata and measured it on the local db — it *flipped* the
monoculture to Sister Jane (235/500 pool, 34/40 page), because stores whose
"brands" are collection labels (Sister Jane "DREAM Showgirls…", STAUD season
codes, Christy Dawn "F24A" codes) get one stratum per label. Source-fair
budgeting is immune to brand-label noise; the parallel junk-brand data fix
improves labels but this design doesn't depend on it.

`queryCandidates` implements this as a lightweight (id, source, brand,
last_seen_at) matching pass + `stratifiedCap` + hydration of the winning ids
(packages/db now depends on @hemline/matching — legal, matching is pure and
depends only on contracts; the algorithm has exactly one home).

### 1b. Diversity guard at final ranking (interleave)

`interleaveByBrand` (packages/matching/src/diversity.ts), applied in
`MatchingService.rank` after scoring/re-rank and **before pagination** (stable
across cursors). A greedy, STABLE MMR-style re-shuffle of the scored order:

| Threshold | Value | Rationale |
|---|---|---|
| `MAX_ADJACENT_SAME_BRAND` | 2 | never 3 same-brand cards in a row |
| `MAX_PER_BRAND_PER_WINDOW` | 6 per 24 | 24/6 = 4 ⇒ a default page shows ≥4 brands whenever the pool has them |
| `MAX_PER_SOURCE_PER_WINDOW` | 12 per 24 | no store exceeds half a page, even hiding behind noisy brand labels |

Properties: pure re-ordering (identical result SET — never a filter);
within-brand relative order preserved (personalized scores dominate); brand
key = normalized brand, falling back to source id for brandless listings.
Constraint relaxation when a page would starve: source cap → brand window
cap → adjacency → pass-through; a single-brand pool (e.g. an explicit brand
filter) is therefore a strict no-op. Palette/style/size behavior untouched —
the guard runs after scoring and changes no scores.

### 1c. Swipe deck sampler

`sampleDeck` (extracted from app/calibrate/page.tsx to apps/web/lib/deck.ts,
now unit-tested) stratifies explicitly across **sources and brands**
(two-level round-robin, rank order preserved within each brand queue) and
keeps the silhouette/length/color preference within each brand's turn
(prefer unseen silhouette, then unseen length|silhouette|color combo). A
12-card deck shows min(#brands, 12) distinct brands; a store with noisy
collection labels gets at most its round-robin share.

### Scope

- `/api/rank` (feed) and `/api/search` (guest + logged-in) share the pipeline
  via `rankForUser` → both get the diversified pool and the guard.
- Explicit-filter search: unaffected as a SET (guard never filters;
  stratification only picks cap survivors, and a brand-filtered query has a
  single brand stratum → identical to plain newest). Ordering *within* a
  multi-brand filtered result is interleaved — accepted, since scores still
  lead and adjacency variety is desirable there too.
- find-similar / listing-detail "similar" pools also read `queryCandidates`
  and inherit the diversified pool.

### Measured before/after (local db copy, guest feed, 168h window replicating the post-crawl moment)

|  | before | after |
|---|---|---|
| pool sources (of 6 live) | 2 (431 Reformation + 69 Sister Jane) | 6 (88/88/87/87/85/65) |
| top-40 brands | 1 (Reformation × 40) | 16 distinct |
| top-40 longest same-brand run | 40 | 2 |
| top-40 sources | 1 dominant | 3 (20/14/6 — source cap 12 per 24 ⇒ ≤20 per 40) |

### Ranking-quality tradeoffs (for the founder)

- When a user's taste genuinely concentrates on one brand, a 24-item page now
  shows at most ~6 cards of it (plus interleave slack) — the rest are the
  next-best-scored other brands. Brand-loyal browsing is one explicit brand
  filter away (guard no-ops there).
- Pool freshness: with a skewed catalog the pool now keeps older listings
  from minority sources instead of the dominant store's marginal extras;
  freshness decay still down-weights them in scoring.
- Sources with honest single brands are bounded by the brand cap (6/24) while
  noisy-label stores are bounded only by the source cap (12/24) until the
  junk-brand data fix normalizes labels; acceptable interim asymmetry.
