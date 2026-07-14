# Scheduler reliability decisions (post-incident 2026-07-10 → fixed 2026-07-14)

Incident: the in-container ingest scheduler's daily store jobs silently
stopped firing after 2026-07-10 (3-day crawl outage) while the 6-hourly eBay
job kept running. The `ingest_stale` health alert never fired because ANY
recent ingest run satisfied it. Logs from the window are gone.

## Root-cause mechanics found in the code

1. **Chain poisoning** — `apps/ingest/src/schedule.ts` (old lines 36–48)
   appended every tick as `chain = chain.then(async () => { const gate =
   shouldRunConnector(db, connector); … try { await runPipeline(…) } catch …})`.
   The `shouldRunConnector` call sat OUTSIDE the try/catch and the chain had
   no `.catch` anywhere. One throw from the gate (two synchronous SQLite reads
   — `isSourceEnabled`; SQLITE_BUSY was live-fire plausible because
   `packages/db/src/client.ts` set no `busy_timeout` while web + scheduler
   write the same file) rejects the chain, and every later
   `.then(onFulfilled)` — every future tick of every job — silently never
   runs.
2. **Permanent hang** — no await in the tick path had a timeout:
   `politeFetch` (packages/connectors/src/framework/politeness.ts) passed no
   AbortSignal, and embed-on-ingest (apps/ingest/src/embedding.ts) constructed
   `EmbedderProcess({ timeoutMs: 0 })` — explicitly disabled. A stalled socket
   or wedged ML sidecar froze the serialized chain forever.
3. **Why eBay survived while dailies died** (the chain-semantics asymmetry):
   a poisoned chain does not stay resident. Node's default
   `unhandled-rejections=throw` (nothing in the repo/Dockerfile overrides it)
   crashes the scheduler child on the first unhandled link; a hung chain ends
   when the child is killed (OOM/deploy — the two hand-swept `status='running'`
   zombie rows prove ≥2 mid-run kills). Either way `docker/start.mjs` restarts
   the scheduler with a **fresh chain**, and node-cron **never replays missed
   ticks**. All daily jobs fire in one 06:00/06:30 wave (Shopify/fixtures
   `0 6 * * *`, JSON-LD `30 6 * * *`), and connectors register
   fixtures→ebay→shopify→jsonld, so eBay's 06:00 tick runs BEFORE the daily
   batch. A failure inside the daily batch therefore costs the dailies their
   only shot of the day — every day the trigger recurs — while eBay simply
   catches its next tick (12:00/18:00/00:00) on the restarted chain. Net
   steady state: eBay ingests 4×/day forever, dailies never run, the process
   looks alive, and any-source `ingest_stale` stays green. Without the outage
   logs we cannot pin WHICH trigger (gate throw vs. hang+kill) fired each day,
   but both live in the same two code paths fixed here, and both produce the
   observed asymmetry.

## Decisions

1. **One protected enqueue path** (`apps/ingest/src/scheduler-core.ts`):
   `createTickChain().enqueue(label, fn)` is the only way ticks join the
   chain — every link is `.then(fn).catch(log)`, so a throwing gate or
   rejecting job terminates at its own link. The gate call moved INSIDE the
   protected tick body (`runConnectorTick`, which never rejects). The one-shot
   runner (run.ts) got the same gate-inside-try fix.
2. **Watchdog per tick**: `runConnectorTick` races the pipeline against
   `INGEST_TICK_TIMEOUT_MS` (default 2h; a monster store legitimately takes
   ~1h). On timeout: loud log, this tick's `status='running'` run row is
   marked `error='watchdog timeout'`, and the chain link resolves so later
   ticks proceed. The abandoned promise keeps running detached but observed
   (late rejection = log line, never an unhandledRejection). Detachment is
   safe: the pipeline is idempotent per content_hash, pruning recomputes each
   run, and if the detached run finishes it overwrites the watchdog marker
   with its real outcome — the honest record.
3. **Zombie sweep at boot**: `sweepZombieRuns` closes `ingest_runs` rows stuck
   in `status='running'` older than `INGEST_ZOMBIE_MAX_AGE_HOURS` (default 6)
   as `error='zombie: swept at boot'` — replaces hand-sweeping after kills.
4. **Per-source `ingest_stale`** (apps/web/app/api/health/route.ts): every
   ENABLED source that has ever completed a successful run must have one
   within `HEALTH_INGEST_STALE_HOURS` (default 30 = daily cadence + slack);
   the alert names the stalest source + age. Disabled sources are ignored
   (the admin toggle is how a retired/banned source — e.g. keyless mock eBay —
   stops paging), never-succeeded sources are skipped (no cadence promise yet;
   `lastIngest: null` keeps a virgin install visible), and error runs don't
   count as success. A fresh run from ANY other source can no longer mask an
   outage — regression-tested against the exact incident shape.
5. **Heartbeat observability** (`apps/ingest/src/scheduler-heartbeat.ts`):
   the scheduler writes `/tmp/hemline-scheduler-heartbeat.json`
   (`SCHEDULER_HEARTBEAT_FILE`) every 60s and on every executed tick, and logs
   a per-day "N scheduled tick(s) executed (job=n, …)" summary at UTC
   rollover. We reuse the ops-bundle litestream *pattern* (tiny /tmp file the
   web process reads in-container; resets with the container) rather than the
   supervisor status file itself — the supervisor only records spawn/exit, and
   the incident's failure mode was a process that is UP but whose cron loop is
   dead. `/api/health` raises `scheduler_dead` when the heartbeat file exists
   but is older than `HEALTH_SCHEDULER_STALE_MINUTES` (default 30), or when
   the supervisor reports the scheduler child down. No heartbeat file → no
   alert (web-only dev). Process-level `unhandledRejection` guard added to the
   scheduler entrypoints: log loudly, keep every cron job alive (a crash-loop
   restart was exactly what made the dailies unrecoverable).
6. **Hang-vector hardening**: `politeFetch` now applies
   `AbortSignal.timeout(HEMLINE_FETCH_TIMEOUT_MS ?? 60s)` per attempt (created
   at request time so politeness-queue wait doesn't consume it; caller-provided
   signals win). Embed-on-ingest uses a finite, batch-scaled embedder timeout
   (`EMBED_TIMEOUT_MS` base 120s + 15s/queued task; EmbedderProcess timers
   start at enqueue). `busy_timeout = 5000` added in createDb so web/scheduler
   write contention retries inside SQLite instead of throwing SQLITE_BUSY.
7. **Extraction-QA "0.00" report**: full audit of
   extraction_confidence → `listExtractionsForQa` → GET /api/admin/extractions
   → panel `toFixed(2)` found every mapping correct on main AND origin/main,
   verified empirically (route repro returns stored values; the e2e screenshot
   renders 0.40/0.50; the local crawled db distribution is healthy, avg 0.69
   live / 0.84 fixture). The all-zeros view can only be genuine stored-0 rows
   surfaced worst-first by the ≤0.6 default filter + ascending sort, or a
   stale deployed build. A route-level regression suite
   (apps/web/app/api/__tests__/admin-extractions.test.ts) now pins the whole
   chain — snake_case/camelCase or wrong-property drift fails loudly with real
   confidences.

## Env knobs added

| Var | Default | Meaning |
| --- | --- | --- |
| `INGEST_TICK_TIMEOUT_MS` | 7200000 (2h) | watchdog budget per scheduled ingest tick |
| `INGEST_ZOMBIE_MAX_AGE_HOURS` | 6 | boot sweep: 'running' rows older than this become errors |
| `SCHEDULER_HEARTBEAT_FILE` | /tmp/hemline-scheduler-heartbeat.json | heartbeat path (scheduler writes, health reads) |
| `HEALTH_SCHEDULER_STALE_MINUTES` | 30 | heartbeat age that raises `scheduler_dead` |
| `HEALTH_INGEST_STALE_HOURS` | 30 (was 36, any-source) | per-source successful-run staleness threshold |
| `HEMLINE_FETCH_TIMEOUT_MS` | 60000 | politeFetch per-attempt hard timeout |
| `EMBED_TIMEOUT_MS` | 120000 (+15s/task) | embed-on-ingest per-request budget base |
