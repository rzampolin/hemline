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

## 2a. Revision (2026-07-08, same day): founder chose option (a) — bake the sidecar in

The founder picked the photo-search upgrade: the FashionSigLIP sidecar now
ships **inside** the production image on a `shared-cpu-1x/4GB` VM
($22.22/mo per current Fly pricing — the shared-cpu-1x line prices RAM
per-GB, so 1x/4GB beats the 2x/4GB $21.40 quote's CPU premium… Fly's
calculator says $22.22 for 1x/4GB and that is the number DEPLOY.md carries).
§2's option (b) analysis stands as the record of why v1 shipped without it;
everything below documents what changed.

**Dockerfile `ml` stage (weights baked at build time):**
- Same `node:22-slim` base as the runtime, `apt python3 + python3-venv`,
  venv at `/app/ml/.venv`. torch **and torchvision** come from the CPU-only
  wheel index (`download.pytorch.org/whl/cpu`) — no CUDA/nvidia payload
  (the default PyPI x86_64 torch would drag ~3GB of CUDA libs); the rest of
  `ml/requirements.txt` from PyPI. Gotcha pinned in the Dockerfile: letting
  PyPI supply torchvision against a `+cpu` torch aborts with
  `operator torchvision::nms does not exist`.
- `manylinux_2_28 +cpu` wheels exist for **both** linux/arm64 (local Apple
  Silicon verify) and linux/amd64 (Fly's remote builders) — verified against
  the index; bookworm's glibc 2.36 satisfies both. So the same Dockerfile
  builds natively on either side; no cross-arch emulation anywhere.
- `RUN embed.py warmup` with `HF_HOME=/app/ml/.hf` downloads the ~860MB
  checkpoint + tokenizer INTO the image layer and smoke-tests one image and
  one text embed — **a broken model fails the build, not the boot**. Runtime
  sets `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`: boot never touches the
  network for weights. A second warmup runs at build time WITH those offline
  vars set — the exact boot configuration — as a gate. It caught a real one:
  transformers 5.x breaks offline loading for tokenizer repos lacking a
  `config.json` (ignores the HF cache's `.no_exist` markers, raises
  "couldn't connect to huggingface.co"); `ml/requirements.txt` now pins
  `transformers>=4.48,<5` (4.57 loads the SigLIP tokenizer offline fine).
  `ml/.venv`, `ml/.cache`, `ml/.hf` stay in `.dockerignore` — the container
  never inherits the founder's macOS venv.
- The ~2GB ml layer is COPY'd into the runner **before** the app layers, so
  app-only rebuilds and re-deploys reuse it from cache.

**Eager load at boot (vs lazy on first request):** eager won. The model load
is 5–20s of torch+weights; lazy would (a) make the first user's photo search
hang for it, and (b) hide a broken/OOMing model until a real user hits it.
Eager (`HEMLINE_ML_EAGER=1` in the image → `apps/web/instrumentation.ts`
fire-and-forgets `warmSharedEmbedder()`) pays the load once at deploy time,
where `fly logs` shows it and a hard failure is visible immediately. The
server accepts traffic during the warmup (health stays 200), and requests
that arrive mid-load simply queue behind the `ready` line inside the bridge.
RAM is NOT an argument for lazy here: the 4GB is provisioned (= paid) either
way (§2's option (c) point).

**Health tells the truth now:** `/api/health` `ml` went from "the venv files
exist" to a real lifecycle — `{sidecarAvailable, state}` with
`state ∈ unavailable | cold | warming | ready | failed`, driven by the
shared child's `ready` protocol line (`packages/matching/src/embedder.ts`
`sidecarStatus()`). `sidecarAvailable` is true for `ready` (model resident)
and `cold` (lazy spawn would work — keeps local-dev semantics identical),
false while `warming` or after `failed`. Local keyless dev without a venv
still reports `unavailable`/false and nothing eager-loads (`HEMLINE_ML_EAGER`
unset in dev).

**Embed-on-ingest goes live in prod:** the pipeline's embed step now finds a
sidecar, so newly crawled listings get vectors automatically — the
"re-upload the db after `npm run embed`" loop from §2 is gone. The
`nothing_missing` branch also logs one line now, so a fixtures run in prod
shows the step executed rather than looking silently skipped.

**fly.toml:** `memory = "4gb"` (same shared-cpu-1x), check `grace_period`
20s → 30s (server still answers health in ~1s; slack for the python spawn),
concurrency kept at 50/100 — probe embeds serialize through one sidecar
child and find-similar is rate-limited 10/min/user, so web concurrency was
never the ML bottleneck.

**Two more gotchas the container verification caught (both now baked into
the Dockerfile as comments/gates):**
- `node:*-slim` ships **no `ca-certificates`** (Node bundles its own CA
  store, so the web app never noticed) — python urllib → system OpenSSL →
  every listing-image download died with CERTIFICATE_VERIFY_FAILED. Runner
  now installs `ca-certificates`; caught because verification ran a REAL
  staud.clothing crawl in the container, not just the fixtures skip path.
- torchvision must come from the same CPU wheel index as torch (see above).

**Measured locally (container, arm64):** image 3.52GB uncompressed (ml layer
1.95GB = venv + 778MB HF cache); app-only rebuild ~1.5–2.5 min (ml layer
cached). Boot: web answers in ~0.2s, model resident at **5.8s** (build-time
warmup on the throttled builder saw 26s — treat 5–30s as the range). RSS:
~1.3GB with the model resident, **1.75GB peak** under concurrent photo-embed
+ feed load — under 44% of the 4GB VM. SIGTERM → clean exit in 0.3s.
Full transcript in the EM report.

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
  with exact enable steps, wiring deferred. *(Superseded by §7 — wired
  2026-07-09.)*

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

## 7. Litestream continuous backup — wired (2026-07-09)

The db now embodies ~$60 of AI extraction plus a day of crawling; "restore
yesterday's Fly snapshot" stopped being an acceptable worst case. The §4
scaffold is now live: Litestream **v0.5.14** ships in the image
(`/usr/local/bin/litestream`, official release tarball, arch-matched via
BuildKit `TARGETARCH` — same Dockerfile on Fly's amd64 builders and local
Apple Silicon; `litestream version` gates the download at build time) with
config baked at `/etc/litestream.yml`.

**Storage: Fly Tigris** (S3-compatible), provisioned by one founder-run
`fly storage create`, which sets the app secrets Litestream consumes —
`BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3` (names verified against Fly's Tigris docs and the
Litestream Tigris guide, fetched 2026-07-09). The config references them via
Litestream's `${VAR}` expansion; nothing secret lives in the repo or image.
Litestream v0.5 auto-detects the Tigris endpoint (signed payloads, no MD5)
and defaults to path-style whenever an explicit endpoint is set — which is
exactly why the identical config also works against the local MinIO
verification rig.

**Sidecar, not `-exec`.** Litestream runs as a third supervised child in
`docker/start.mjs` (`litestream replicate -config /etc/litestream.yml`),
replicating the live db over its own read-only SQLite handle — safe by
design with WAL. The alternative — wrapping the app in
`litestream replicate -exec "node docker/start.mjs"` — was rejected: it
inverts process ownership (litestream becomes PID 1 and the supervisor of
our supervisor), gives us its one-size exit policy instead of ours
(web-fatal / scheduler-retry, §1), and couples storefront lifecycle to the
backup tool. `-exec` earns its keep when it must gate app start on
`restore -if-db-not-exists`; we deliberately keep restore manual (below).

**Failure/skip policy mirrors the scheduler:** death → restart with 5s→5min
capped backoff — a broken backup pipe must never take the storefront down
(Fly volume snapshots still exist underneath). When any of the four env vars
is missing, the supervisor logs one info line naming the missing vars and
runs without the child — local docker and dev behavior is byte-for-byte
unchanged. `LITESTREAM_REPLICATE=off` force-disables it; that switch exists
for the volume-loss restore drill, where booting an EMPTY volume with
replication live would immediately start backing up the empty db over the
good replica (the footgun is called out in DEPLOY.md's runbook).

**Settings** (`docker/litestream.yml`): `sync-interval: 10s` — caps the
crash data-loss window at ~10s; writes are bursty (daily crawls, sporadic
user actions), so steady-state PUT volume is trivial and 10s costs nothing
over 60s while being 6× tighter. `snapshot: interval 6h, retention 72h` —
point-in-time restore reaches back 3 days at ~12 snapshots × ~12MB ≈ 150MB
of bucket (~free on Tigris); anything older falls back to Fly's daily
volume snapshots (5 kept), so the combined worst case stays "yesterday" only
beyond 72h. Defaults kept for everything else (1s monitor, 1m checkpoint).

**Restore is manual and runbook'd** (DEPLOY.md §10): restore to a temp path
with `-integrity-check full`, verify table counts via a better-sqlite3
one-liner (the image has no sqlite3 CLI; node + the standalone node_modules
are already there), `mv` over the live path, drop stale `-wal`/`-shm`,
restart. Two disaster scenarios documented: bad migration (volume intact)
and volume loss (disable replication first — see footgun above). No
auto-restore-on-boot: an intentionally fresh volume (new region, demo seed)
must stay possible without the backup resurrecting old data.

**Verified locally (transcript in the EM report):** image built on arm64;
container ran a COPY of the founder's db with a MinIO container as the S3
target; supervisor started the litestream child (and skipped it with one
log line when secrets were absent); writes to the db appeared in the bucket
within the sync interval; container hard-killed; `litestream restore` onto a
fresh path passed `integrity_check` with row counts identical to the
pre-kill db. Image size delta: ~+28MB (the litestream binary + config).
