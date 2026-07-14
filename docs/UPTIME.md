# Uptime monitoring — founder setup (3 minutes)

The app self-diagnoses at **`GET https://hemline.fly.dev/api/health`** (no
auth, safe to poll). Fly's own health checks restart a dead machine, but they
don't *tell you* anything — an external monitor closes that gap. We can't
create the account for you (needs your email), so here are the exact steps.

> When the custom domain lands (docs/DOMAIN.md), update the monitor URL to
> `https://<domain>/api/health` — everything else stays the same.

## What the endpoint reports

`200` + JSON envelope when healthy. Two signals matter for monitoring:

1. **HTTP status.** `503` = database unreachable/corrupt (the worst case);
   no response = machine/region down.
2. **The `alerts` array** (in `data.alerts`). Empty (`"alerts":[]`) means
   nothing to flag. Non-empty means one of:

   | code | meaning | urgency |
   |---|---|---|
   | `ingest_stale` | no crawl started in >36h — catalog is going stale | today |
   | `error_spike` | ~20+ server errors in the last hour (details: `/admin` Errors panel) | today |
   | `litestream_down` | the backup child is not running — replication gap grows | today |
   | `ml_failed` / `ml_unavailable` | visual search degraded to attribute fallback (site still works) | this week |

## Option A — UptimeRobot (recommended: keyword monitor covers both signals)

1. Sign up at https://uptimerobot.com (free tier: 50 monitors, 5-min interval).
2. **+ New monitor** → type **Keyword**.
   - URL: `https://hemline.fly.dev/api/health`
   - Keyword: `"alerts":[]` (exactly, with the quotes and no spaces — the
     JSON is unformatted)
   - Alert When: **Keyword Not Exists**
   - Interval: 5 minutes
3. Add your email (and optionally the mobile app push) as the alert contact.
4. Done. This single monitor fires on: machine down, HTTP 503 (db dead),
   AND any self-diagnosed alert (stale ingest, error spike, litestream down,
   ml failed) — because in every one of those cases the literal string
   `"alerts":[]` stops appearing in the response body.

Optional second monitor (belt and braces): type **HTTP(s)** on the same URL,
so you get a distinct "site down" vs "site degraded" signal.

## Option B — healthchecks.io style (if you prefer it)

healthchecks.io is ping-based (the app must call *them*), which doesn't fit a
pull health endpoint without adding a cron. Prefer UptimeRobot here. If you
want healthchecks.io anyway, the equivalent is a scheduled GitHub Action /
external cron running:

```bash
curl -fsS https://hemline.fly.dev/api/health | grep -q '"alerts":\[\]' \
  && curl -fsS https://hc-ping.com/<your-uuid> > /dev/null
```

(only pings "OK" when healthy AND alert-free; healthchecks.io alerts when the
ping stops).

## What to do when it fires

- **No response / 503** → `fly status`, `fly logs`; Fly usually restarts the
  machine itself. If the db is corrupt: DEPLOY.md "RESTORE runbook".
- **`ingest_stale`** → `/admin` crawler health panel; trigger a run via
  `POST /api/admin/ingest`.
- **`error_spike`** → `/admin` Errors panel shows the deduped groups with
  stacks; `fly logs` for live context.
- **`litestream_down`** → `fly logs | grep litestream`. The supervisor
  restarts it with backoff (up to 5 min) — a persistent alert means bad
  credentials/bucket, not a transient crash. Backup gap is bounded by Fly's
  daily volume snapshots underneath.
- **`ml_failed`** → non-urgent; `fly apps restart hemline` re-runs the eager
  warmup. Visual search falls back to attributes meanwhile.

## Honest limits

- The 5-minute free-tier interval means up to ~5 min of blindness.
- `error_spike` uses hourly buckets (a 1–2h sliding window), and the
  `litestream_down` check reads a status file written by the in-container
  supervisor — if the whole container dies, you learn it from the HTTP
  check, not from `alerts`. Both are documented in docs/decisions-ops.md.
- `lastIngest` age is also exposed raw (`data.lastIngest.ageSeconds`) if you
  ever want a tighter custom threshold than the built-in 36h
  (`HEALTH_INGEST_STALE_HOURS`).
