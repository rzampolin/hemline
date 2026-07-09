# Deployment Engineering Decisions — Fly.io production (2026-07-08)

Deliverables: `Dockerfile`, `.dockerignore`, `fly.toml`, `docker/start.mjs`
(supervisor), `docker/entry-scheduler.ts`, `scripts/prod-seed.ts`,
`/api/health`, prod hardening (session secret guard, admin deny-by-default,
AI rate limits), `DEPLOY.md`. Verified locally with `docker build` + a
container run against a copy of the founder's db — transcript in DEPLOY
report; nothing here was deployed (founder's Fly account does the launch).

## 1. One machine, one container, two processes

SQLite on a Fly volume is the binding constraint: volumes attach to exactly
one machine, and better-sqlite3 is a single-writer client. So the web server
and the node-cron ingest scheduler MUST share that machine — separate
`[processes]` groups create separate machines (and the second one gets an
empty volume). Hence a single container whose PID 1 is `docker/start.mjs`:

- **web** = Next standalone `server.js`. Its death kills the container →
  Fly restarts the machine. The storefront is the reason the box exists;
  crash-looping visibly beats limping.
- **scheduler** = `dist/ingest-scheduler.mjs` (see §3). Its death is logged
  and retried with exponential backoff (5s → 5min cap). A broken crawler
  must never take the storefront down.
- SIGTERM/SIGINT forwarded to both, 8s grace, then SIGKILL — `fly deploy`
  rotations and `docker stop` exit clean (WAL-checkpointed).

Why hand-rolled (~130 lines) instead of `concurrently`/pm2/supercronic:
`concurrently` gives one exit policy for both children (wrong: we need
web-fatal + scheduler-retry), pm2 is a heavyweight daemon with its own state
dir, and in-app cron (importing node-cron inside a Next route module) ties
crawler lifecycle to Next's bundling/HMR semantics and makes the scheduler
unkillable independently. The supervisor is boring, dependency-free, and the
policy is explicit.

The supervisor also starts as **root only to `chown` the volume mount** (Fly
mounts volumes root-owned), then irreversibly drops to the `node` user via
`process.setuid` before spawning anything. Both app processes run non-root.

## 2. ML-at-runtime: ship v1 WITHOUT the sidecar (option b)

Grounded numbers (Fly pricing page, fetched 2026-07-08; torch/model sizes
from docs/decisions-ml-eng.md):

| Option | Image | RAM need | VM | $/mo (VM) |
|---|---|---|---|---|
| (b) no ML in container | ~0.6GB | ~300–700MB | shared-cpu-1x/2gb | **$10.70** |
| (a) python sidecar baked in | ~4GB (torch 1.6GB + model 0.78GB) | ~1.5–2GB loaded | shared-cpu-2x/4gb | $21.40 |
| (c) lazy-load on first use | ~4GB | same peak as (a) | still 4gb (provisioned = paid) | $21.40 |
| reference: always-on 1GB | — | too tight w/ sharp + rerank | shared-cpu-1x/1gb | $5.70 |

(c) is strictly worse than (a) on Fly: you pay for provisioned RAM whether or
not the model is resident, and first-query latency becomes 10–20s model load.

The decisive product fact (decisions-ml-eng.md degradation matrix): **feed
ranking keeps the 0.6/0.4 embedding blend without Python**, because it only
*reads* the 1,616 stored vectors shipped inside hemline.db. What actually
degrades without the sidecar is probe embedding: photo/free-text visual
search falls back to the attribute-extraction path (`matchBasis:
'attributes'`), and embed-on-ingest logs a skip line (`skipped: 'no_sidecar'`)
so newly crawled listings stay on the attribute path until vectors are
refreshed locally and the db re-uploaded.

For a beta that's the right trade: half the monthly cost, a ~7× smaller image
(faster deploys/rollbacks), and zero risk of the model OOMing the storefront.
Upgrade paths documented in DEPLOY.md (second ML-only machine, or bake-in +
4GB). Every ML-absent code path was already null-safe by design; verification
(§6) exercises the container with no Python at all.

## 3. Image: Next standalone + esbuild bundles, one gotcha

- `output: 'standalone'` with `outputFileTracingRoot` = repo root works with
  npm workspaces: `.next/standalone` mirrors the monorepo
  (`apps/web/server.js` + traced `node_modules` incl. the linux builds of
  better-sqlite3/sharp — both already `serverExternalPackages`). Verified by
  running the standalone server directly.
- The scheduler / one-shot ingest / seed can't use standalone (they're tsx
  scripts), and shipping tsx + full node_modules would drag ~500MB of
  devDeps. Instead the build stage **esbuild-bundles three entrypoints** to
  `dist/` (~1.7MB each), externals only `better-sqlite3` + `sharp`, resolved
  from the standalone node_modules.
- **Gotcha that cost an hour:** `seed.ts` and `schedule.ts` end with
  `if (import.meta.url === pathToFileURL(argv[1]).href) main()`. Inside a
  single-file bundle every module shares the bundle's `import.meta.url`, so
  the guard turns TRUE on import → module-level side effects fire (seed ran
  before `ensureSchema`; run.ts would have started the scheduler too).
  Fix without touching owned code: each bundle is launched through a
  one-line launcher (`dist/seed.mjs` → `import "./impl/seed.impl.mjs"`), so
  `argv[1]` never equals the bundle's URL and the guards stay false;
  explicit entry files (`docker/entry-scheduler.ts`, `scripts/prod-seed.ts`)
  invoke what should run.
- node:22-slim (Debian) not alpine: better-sqlite3/sharp ship glibc prebuilds;
  musl would mean a native toolchain in the image.
- Final image ~0.6GB, non-root runtime (§1), `HEALTHCHECK` wired to
  `/api/health` for local docker; Fly uses the fly.toml check.

## 4. fly.toml choices

- `auto_stop_machines = "off"`, `min_machines_running = 1`: the cron
  scheduler lives in the machine; auto-stop would silently kill daily crawls.
  Cost of always-on is the $10.70 above — that IS the product decision.
- 2GB RAM: Next RSS ~250MB + sharp spikes on color-analysis + 30MB vector
  cache + SQLite page cache; 1GB would work until the first concurrent
  selfie-analysis + crawl, 2GB removes the OOM class for $5/mo.
- `[[http_service.checks]] GET /api/health` (db reachable + counts + last
  ingest age + ml flag; no secrets). 20s grace covers standalone boot (<1s
  observed) with margin.
- `snapshot_retention = 5` daily volume snapshots = beta backup.
  **Litestream evaluated:** worth it eventually (point-in-time restore,
  off-Fly copy) but it adds a binary, a bucket, credentials, and a restore
  drill to the beta cutline — scaffolding committed at `docker/litestream.yml`
  with exact enable steps, wiring deferred.

## 5. Hardening

- **SESSION_SECRET:** production refuses to start (exit 1) when unset /
  placeholder / <32 chars — enforced twice: `apps/web/instrumentation.ts`
  (any prod `next start`, incl. standalone) and `docker/start.mjs` (clearer
  message before anything spawns). Dev keeps the permissive fallback.
- **ADMIN_BASIC_AUTH:** `checkAdminAuth` now denies all in production when
  unset (dev stays open-with-warning). All three admin routes already route
  through it; verified 401 in the container.
- **Rate limits** (in-memory sliding window, `api/lib/rate-limit.ts`):
  color-analysis 5/min/user, find-similar 10/min/user, rank-personalize
  20/min/user — but rank *degrades to deterministic ranking* instead of
  429ing (limiter guards spend, not access; feed never breaks). In-memory is
  correct here because prod is exactly one machine (§1) — documented as the
  thing to revisit if that ever changes. Active only when
  `NODE_ENV=production` (or `RATE_LIMIT_FORCE=1`) so dev/tests/QA suites are
  untouched. `AI_DAILY_BUDGET_USD` remains the hard spend cap behind it.
- **Dev-endpoint sweep:** all `/api/admin/*` behind basic auth;
  `NEXT_PUBLIC_API_MOCK` is a build-time client flag (off in the prod image);
  no debug/test routes exist under `app/api`; `.env*`, `data/`, `e2e/`,
  `.claude/` excluded from the build context.

## 6. What was verified locally (summary — full transcript in the EM report)

1. `npm run build` green with standalone output; `npm test` 39 files /
   512+ tests green; lint green.
2. `docker build` succeeds on Apple Silicon (arm64 image for local verify;
   `fly deploy` rebuilds on Fly's amd64 builders — better-sqlite3/sharp have
   prebuilds for both, nothing arch-specific in the repo).
3. Container + volume dir containing a copy of the founder's db:
   `/api/health` ok (1,784 listings / 1,616 vectors), landing page 200,
   `/api/rank` for the demo user returns ranked items, `[scheduler]` logs
   show cron jobs registered, admin 401s without auth, missing SESSION_SECRET
   aborts startup, `dist/seed.mjs` populates an empty volume, one-shot
   `dist/ingest-run.mjs --source=fixtures` runs, embed step skips with
   `no_sidecar` (ML-absent path clean).
