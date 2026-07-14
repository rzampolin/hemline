# Decisions — Paste-a-dress-link fit check (2026-07-13)

The flagship from the original product strategy: paste ANY dress PDP URL →
Hemline fetches the page, reads the garment, and renders a fit check against
HER profile plus similar in-catalog alternatives. Zero install, works from a
phone's share/paste (`/check?url=` auto-runs).

## 1. Pasted products are EPHEMERAL — never listings

A pasted URL never creates a `listings` row, never enters the feed, never gets
embedded into the catalog. Only the user-independent PAGE PARSE (plus the
extraction attributes, when one ran) is cached in the new additive
`fit_check_cache` table, keyed by sha256(normalized URL), ~24h TTL. The
per-user math (hem verdict, size match, similar rack) is recomputed on every
request. Fetch failures are cached as NEGATIVE entries with a 5-minute TTL so
a flaky/blocking store isn't hammered by retries, but recovers quickly.
URL normalization strips fragments and tracking params (`utm_*`, `fbclid`,
`gclid`, …) so share-sheet URLs with tracking tails hit the same cache row.

## 2. SSRF guard design (apps/web/app/api/lib/safe-url.ts)

This is a server-side fetch of an arbitrary user-supplied URL — the guard is
layered and applied to EVERY request, including robots.txt and the Shopify
`.js` probe:

1. **URL shape**: https only, default port only, no embedded credentials,
   hostname blocklist (`localhost`, `*.local`, `*.internal`, `*.home.arpa`,
   `metadata.google.internal`, …).
2. **IP literals** validated directly against the private/reserved matrix:
   v4 loopback/RFC1918/link-local (169.254 — cloud metadata)/CGNAT/0.0.0.0/
   test-nets/multicast+; v6 loopback/unspecified/ULA fc00::/7/link-local
   fe80::/10/NAT64/doc ranges, plus IPv4-MAPPED v6 (`::ffff:10.0.0.1`)
   unwrapped and re-checked.
3. **DNS resolution**: every address a hostname resolves to must be public —
   one private A record among public ones rejects the URL.
4. **Manual redirects**: `redirect: 'manual'`, max 3 hops, EVERY hop re-runs
   layers 1–3 (a public page cannot bounce us into 169.254.169.254; an https→
   http downgrade is rejected).
5. **Resource caps**: body size cap enforced mid-stream (3 MB), one
   `AbortSignal.timeout` covering all hops (10 s) — never a hang.

Known residual risk (documented, accepted): validate-then-fetch has a
DNS-rebinding TOCTOU window (we validate the resolution, then Node's fetch
re-resolves). Closing it fully requires pinning the dispatcher's lookup
(undici Agent). Mitigations in place: the re-resolution window is milliseconds,
redirects are re-validated, and the response is only ever parsed as
text/JSON — never proxied back to the user verbatim.

The route never throws for a bad page: SSRF-rejected URLs are an honest
`blocked_url` outcome (HTTP 200 envelope), unreadable pages are `unreadable`
with slug-derived keywords offering a catalog search instead.

## 3. Parser: softer rules than the crawl (packages/connectors/src/external)

`extractListingFromHtml` is built for ingest (price required, kids silently
dropped, store config required). The fit check needs different semantics, so
a new exported helper module reuses the same primitives (JSON-LD extract,
microdata, og:image, dress heuristics, audience detection, Shopify
availability) with softer rules:

- **missing price is fine** — the hem verdict doesn't need one;
- **kids items are REPORTED** (`child_audience`), not swallowed — "that looks
  like a kids' item" is the graceful UX;
- an extra **og:-metas tier** below JSON-LD/microdata catches pages with no
  schema.org data at all (title/image/price/currency from OpenGraph); og-only
  pages must say "dress" in the title or slug, and bot-block interstitial
  titles ("Access Denied", "Just a moment…") are rejected outright.

Chain order (richest first): Shopify `/products/{handle}.js` (fetched by the
route when the URL matches `/products/`) → JSON-LD Product/ProductGroup →
microdata (+ breadcrumb category) → og:. The `.js` tier tolerates BOTH the
storefront `.js` shape (integer-cent prices, bare-string images, `type`/
`description`) and the `.json` mirror shape (products.json-like); a non-JSON
or non-product `.js` response falls through to the HTML chain (so
SFCC stores like Reformation whose URLs contain `/products/` cost one extra
request, then parse via JSON-LD).

Model height: brands state it in body copy, not structured data — the
existing `parseModelInfo` runs over the FULL fetched page text at fetch time
and the result rides the cache.

## 4. Politeness

Same identified `HemlineBot/1.0` UA as every other Hemline fetcher.
robots.txt is fetched (SSRF-guarded, 4 s budget) and the PDP path checked
with the connectors' `isPathAllowed`; a disallow is an honest `unreadable`
("we couldn't read that page"), unreachable robots = allowed (matches
decisions-data-eng #4). Per-host politeness delays are not serialized here —
each check is one user-triggered fetch (max 3 requests: robots + .js + HTML)
and the per-user rate limit (10/min, find-similar pattern) bounds volume.

## 5. Degradation matrix (verified by tests)

| failure | behavior |
| --- | --- |
| no ANTHROPIC_API_KEY / budget cap | deterministic rule-engine extraction, `extractionMode: 'mock'` (honest) |
| live extraction slower than 15 s | raced against a deadline → rule engine (never a hang) |
| no ml sidecar / no vectors | attribute-vector cosine similarity, `matchBasis: 'attributes'` |
| bot-blocked / 4xx / network / garbage HTML | `outcome: 'unreadable'` + slug keywords → catalog search CTA |
| robots disallow | `unreadable` (respectful + honest) |
| private/non-https URL | `outcome: 'blocked_url'`, zero network I/O |
| kids item | `outcome: 'child_audience'` (parser text pass AND extraction audience field) |
| non-dress product | `outcome: 'not_a_dress'` |
| she has no height | hem basis `'none'` + "add your height" CTA |
| size/budget filter empties the similar rack | constraint relaxed rather than an empty grid |

## 6. Similar-rack composition

Embedding tier requests top 48 visual matches, hydrates, then filters to her
sizes/budget and takes 8 (relaxing when empty); attribute tier queries
candidates WITH the size/budget SQL filters first (falling back to the whole
pool), cosine-ranks, takes 8. Same `RankedListing` wire shape as every grid —
`hem` computed for HER on each card.

## 7. Guests + share-sheet arrival

POST /api/fit-check uses `ensureSessionUser` (mints a session + cookie)
instead of `requireUserId` — an iOS share-sheet arrival has no cookie yet and
must not 401 on the very first magic moment. Rate limit key = user id,
10/min (find-similar precedent).

## 8. Analytics

Closed-whitelist additions (contracts/analytics.ts):
`fit_check_submitted { parsed, inCatalog }` and
`fit_check_result_clicked {}`. No URL is ever sent to analytics (PII rule);
`inCatalog` is computed server-side by exact sourceUrl match.

## 9. Live probes (2026-07-13, polite, HemlineBot UA)

- `https://staud.clothing/products/yuca-dress-tidal-shell.js` — recorded
  VERBATIM as `packages/connectors/src/external/__fixtures__/staud-yuca-dress.js.json`
  (integer-cent prices at product and variant level, bare-string images,
  `type`, `description` — the `.js` shape deviations are all encoded in the
  parser + tests).
- `https://www.thereformation.com/products/winslow-dress/0503333.html` —
  JSON-LD block, og: metas, and the model-info snippet ("model is wearing a
  size XS and is 5'9\"") recorded into
  `__fixtures__/reformation-winslow-dress.html` (page trimmed from 498 KB;
  the recorded blocks are verbatim).
- `realisationpar.com` (intended microdata probe) — its sitemap 404s now;
  the microdata tier is covered by the synthetic sample modeled on the
  2026-07-08 verbatim capture in `jsonld/microdata.test.ts`.
