# Decisions — Production reliability (ops)

2026-07-13 · error tracking, restore drill kit, uptime alerts, custom-domain
prep. Constraint honored throughout: nothing here can write to
`/data/hemline.db` beyond additive schema, and nothing runs against prod —
everything is prepared for the EM to execute.

## 1. Error tracking: self-rolled, aggregate-only (`app_errors`)

**Shape.** One row per DEDUPED error group, not per event: PK is
`stack_hash` = sha256(route + digit-stripped message + top-5 stack frames
with line/col numbers removed). Repeats bump `count`/`last_seen_at` and
refresh message/stack (freshest repro detail wins). Message capped at 500
chars, stack at 4000.

**Bounded by construction.** `recordAppError` prunes on every NEW-group
insert (not on dedup updates): drop groups unseen for 30 days, then keep the
500 most-recently-seen. An error loop therefore converges to one row with a
big count; a cardinality explosion converges to 500 rows. No cron needed.

**Spike signal without event rows.** `hour_bucket`/`hour_count` columns hold
a per-group counter that resets when the wall-clock hour rolls over.
`appErrorStats` sums buckets ≥ (current−1) — an *approximate 1–2h sliding
window*. Accepted imprecision: it's a threshold trigger (default 20, env
`HEALTH_ERROR_SPIKE_THRESHOLD`), not a metric.

**Wiring — three funnels, one choke point** (`captureError` in
`apps/web/app/api/lib/error-capture.ts`, which never throws):

1. `envelope.serverError` — every route's catch path already goes through it;
   zero per-route changes.
2. Next 15 `onRequestError` in `instrumentation.ts` — uncaught render/route
   errors. Same Edge/Node split as `register()` (constant-folded
   `NEXT_RUNTIME` check + dynamic import of `instrumentation-node`,
   docs/decisions-admin-ui.md §2). No double counting: routes that catch
   never reach the hook.
3. Supervisor children: **deliberately NOT db-writing.** PID-1 (`start.mjs`)
   opening better-sqlite3 against the live db would add a second writer
   process class for marginal value. Instead the supervisor keeps the last 20
   stderr lines per child in memory and writes them into the status file on
   child exit (crash context), and container logs keep the full stream.

**Surface.** `GET /api/admin/errors` (basic-auth, read-only) + an Errors
panel in `/admin` (grouped, expandable stacks, 60s poll). `/api/health` gets
counts only (`errors: {groups, lastHour}`) — the endpoint is public, so no
messages/stacks leak there.

## 2. Restore drill: `dist/restore-drill.mjs`, dry-run by default

Bundled via the existing Dockerfile launcher pattern. **EM command:**

```bash
fly ssh console -C "node /app/dist/restore-drill.mjs"        # plan only (default)
fly ssh console -C "node /app/dist/restore-drill.mjs --run"  # actual drill
```

Design decisions:

- **Refusal is code, not convention** (`docker/restore-drill-core.ts`,
  unit-tested): output must resolve under /tmp, must not be under /data at
  all, and must not equal the live db or its `-wal`/`-shm`. Checked before
  anything else, including in dry-run.
- **Dry-run by default** (`--run` opt-in) per the prod-safety rail; the plan
  output includes the exact litestream command it would run.
- **Disk guard before restore:** `fs.statfsSync` on the output dir; require
  live-size × 1.2 + 64 MiB.
- **Own verification instead of `-integrity-check full`:** we run `PRAGMA
  integrity_check` + per-table row-count comparison ourselves (live db opened
  strictly `{readonly, fileMustExist}`), so the drill doesn't depend on a
  litestream CLI flag surviving version bumps, and the report shows *counts*,
  which is what a founder can sanity-check against /api/health.
- **Tolerance window** ±max(2%, 5 rows) per table (`--tolerance` to widen):
  the replica legitimately lags ~10s and the live db keeps writing during the
  drill. `_litestream*`/`sqlite_*` tables excluded.
- Temp file (+wal/shm) deleted afterwards (`--keep` to inspect); exit code
  0/1 = PASS/FAIL. Point-in-time via `--timestamp`.

## 3. Health alerts + litestream visibility

`/api/health` gains an additive `alerts` array (codes: `ml_failed`,
`ml_unavailable`, `ingest_stale` >36h — env `HEALTH_INGEST_STALE_HOURS`,
`error_spike`, `litestream_down`). "db unreachable" is intentionally NOT an
alert entry — it's the existing 503 path, and status≠200 is already the
strongest signal a monitor can get. An empty array serializes as the literal
`"alerts":[]`, which is exactly what the UptimeRobot keyword monitor watches
(docs/UPTIME.md).

**Litestream child visibility.** The supervisor writes
`/tmp/hemline-supervisor.json` on every child spawn/exit (`{up, pid,
restarts, lastExit, stderrTail}` per child) and touches
`/tmp/litestream-alive` on every litestream spawn — the health route prefers
the status file (precise: down = spawned-then-exited, exactly matching the
supervisor's backoff gap) and falls back to heartbeat-file existence.
**Honest limits:** the files are container-local and reset on boot; if the
supervisor itself dies the whole container dies with it (web death = container
death), so staleness of the file is not a real failure mode we need to
detect; a litestream child that is *running but wedged* (not replicating)
looks "up" — the true backstop for that is the restore drill (§2) and
`fly logs | grep litestream`. Alert only fires when replication is *expected*
(all four S3 secrets present and `LITESTREAM_REPLICATE != off`), so local/dev
and the documented restore procedure never false-positive.

## 4. Custom-domain prep

Audit result: `hemline.fly.dev` was hardcoded **only in DEPLOY.md examples**
— app code had zero absolute self-URLs, but also no `metadataBase` (OG URLs
were resolving relative). Fixed by introducing `apps/web/lib/app-url.ts`
(`APP_URL` = `NEXT_PUBLIC_APP_URL` with fly.dev fallback) and wiring
`metadataBase`. Because `NEXT_PUBLIC_*` is inlined at build time, the value
flows through a Dockerfile `ARG` + `fly.toml [build.args]`, with a runtime
`[env]` copy for server code — a domain change is a two-line fly.toml edit +
`fly deploy` (docs/DOMAIN.md). `CRAWLER_CONTACT` was already env-driven
everywhere; DOMAIN.md covers switching it to a domain address.

## Tests

- `packages/db/src/query/app-errors.test.ts` — capture/dedup/truncation/
  hourly counter/prune (12).
- `docker/restore-drill-core.test.ts` — refusal guard, disk guard, count
  comparison, report, arg parsing (19; vitest `include` gained
  `docker/**/*.test.ts`).
- `apps/web/app/api/__tests__/ops.test.ts` — serverError capture,
  onRequestError body, /api/admin/errors auth+payload, health errors/alerts
  incl. litestream status-file/heartbeat matrix (9).

Baseline 932 → **972**, typecheck/lint/`next build`/docker build green.
