# Decisions — rebrand Hemline → Soline (2026-07-13)

The working name "Hemline" becomes the real product name **Soline** (French
given name, so-LEEN). Scope was user-visible brand strings only; this doc
records what changed, what deliberately did not, and why.

## 1. What changed

- **apps/web UI copy + metadata**: root layout title default/template,
  `openGraph.siteName`, OG image alt; landing wordmark + hero/how-it-works
  copy; /about (title, OG title, wordmark, h1, body copy); marketing footer;
  feed header wordmark; check-page error copy ("Soline only does dress
  math"); profile copy; admin title + "Soline Ops" heading; palette
  share-card canvas text (`result-view.tsx` — the canvas `fillText`
  wordmark baked into the downloaded PNG, the lowercase caption
  "my colors, by soline" in both the canvas and the on-screen card, and the
  download filename `soline-<season>.png`).
- **OG image**: `apps/web/scripts/generate-og.mjs` wordmark → Soline;
  `public/og.png` regenerated from it.
- **Crawler identity**: `HemlineBot/1.0` → `SolineBot/1.0` in all three
  places that build the UA string — `packages/connectors` politeness.ts,
  `packages/ai` images/fetcher.ts (deliberately duplicated pair named in the
  brief), **and** `apps/web/app/api/lib/safe-url.ts` (the fit-check fetcher
  builds the same identity string inline; leaving it would have split the
  bot identity). Tests updated in connectors framework + robots + ai fetcher.
- **`ROBOTS_AGENT_TOKEN`**: `'hemlinebot'` → `'solinebot'`
  (packages/connectors/src/framework/robots.ts). Treated as part of the
  crawler identity, not an internal identifier: it is the product token that
  robots.txt `User-agent:` groups match against. Keeping the old token while
  sending a `SolineBot` UA would mean site owners addressing rules to
  SolineBot are ignored while phantom HemlineBot rules still apply.
  Consequence: any site that had already written a `User-agent: HemlineBot`
  robots group no longer targets us specifically — acceptable pre-launch.
- **e2e**: brand-text assertions in admin.spec.ts ("Soline Ops") and
  happy-path.spec.ts ("How Soline works").
- **Docs (light touch)**: README title/intro; DEPLOY.md title (the brief
  said docs/DEPLOY.md — the file lives at repo root); packages/connectors
  OWNER.md UA mention (describes live code, would otherwise be wrong).
  docs/UPTIME.md needed no change — its only "hemline" mentions are
  hemline.fly.dev URLs and the fly app name, which stay.

## 2. What deliberately did NOT change

- **Garment-term "hem"/"hemline"** everywhere (hem math copy, HemBadge,
  hem diagrams, "a literal hemline in bordeaux" comment, CSS/design tokens).
- **The tagline** "That maxi? It's a midi on you."
- **Internal identifiers**: `@hemline/*` package names, fly app `hemline`,
  `hemline.fly.dev` URLs (APP_URL default — domain purchase pending, see
  docs/DOMAIN.md), `DATABASE_PATH`/`data/hemline.db`, `hemline_session`
  cookie, `hemline:*` localStorage keys, db/table names, docker image tag,
  e2e isolated db `data/hemline-e2e.db`.
- **`HEMLINE_*` env var names** (e.g. `HEMLINE_CRAWL_DELAY_MS`,
  `HEMLINE_IMAGE_FETCH_DELAY_MS`, `HEMLINE_ML_EAGER`): renaming would break
  existing fly secrets/local .env files for zero user-visible gain; revisit
  if/when a config migration is otherwise needed.
- **Function names** `hemlineUserAgent()` / `hemlineImageUserAgent()`:
  internal identifiers; only the string they return is the public identity.
- **LLM system prompts** ("You are Hemline's …" in packages/ai extraction/
  search/rerank/color/audience/lengths): not user-visible (sent only to the
  Claude API), and edits would churn prompt text (and any prompt-keyed
  caching) outside the brief's scope. Flagged for a follow-up pass if the
  team wants model-facing identity aligned too.
- **Decisions-doc history** (docs/decisions-*.md) and point-in-time docs
  (ARCHITECTURE.md, DOMAIN.md, QA_REPORT.md, PRODUCT_SPEC.md): historical
  record keeps the old name.
- **docker/restore-drill-core.ts** report banner ("Hemline restore drill
  report"): internal ops tooling output, out of scope.
