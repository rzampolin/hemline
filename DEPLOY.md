# Deploying Hemline to Fly.io

One machine, one volume, one container running the web server, the ingest
cron scheduler, **and the FashionSigLIP ML sidecar** (baked into the image —
photo/text visual search and embed-on-ingest run in production). Design
rationale in `docs/decisions-deploy.md`.

**The database ships, not seeds:** production gets your local
`data/hemline.db` (the extracted listings + their FashionSigLIP vectors)
uploaded to the volume. A fresh empty volume still boots — the app creates the
schema itself and shows an empty state — and can be demo-seeded from inside
the machine (step 8).

---

## 0. Prereqs

- `flyctl` installed and logged in (`fly auth login`)
- This repo checked out with your populated `data/hemline.db`

## 1. Create the app (no deploy yet)

```bash
fly launch --no-deploy --copy-config --name hemline
```

`--copy-config` keeps the committed `fly.toml` (volume mount, health check,
4GB VM, `auto_stop_machines = "off"`). If the name `hemline` is taken, pick
another — everything else stays the same. If you change `primary_region`,
change it before creating the volume (volumes are region-pinned).

## 2. Create the volume (same region as the app)

```bash
fly volumes create hemline_data --region ewr --size 3
```

3GB is plenty (the db is ~12MB today; images are hotlinked, never stored).
Volume cost: 3GB × $0.15 = **$0.45/mo**. Fly takes daily snapshots
(kept 5 days per `fly.toml`) — that's the beta backup story.

## 3. Set secrets

```bash
fly secrets set \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  ADMIN_BASIC_AUTH="admin:$(openssl rand -hex 12)" \
  ANTHROPIC_API_KEY="sk-ant-..."
```

Write down the `ADMIN_BASIC_AUTH` value — it's the HTTP Basic login for
`/api/admin/*`. Notes:

- **SESSION_SECRET is mandatory.** The container refuses to start in
  production with a missing/placeholder/short secret (startup guard).
- **ADMIN_BASIC_AUTH is mandatory in practice**: without it, admin endpoints
  return 401 for everyone in production (deny-by-default).
- `ANTHROPIC_API_KEY` is optional — without it the app runs in deterministic
  demo mode (no LLM extraction/re-rank/color analysis). `AI_DAILY_BUDGET_USD`
  (default 5, set in `fly.toml`) hard-caps daily spend either way.
- Optional: `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` to turn the eBay
  connector live (it serves fixtures otherwise).

## 4. First deploy

```bash
fly deploy
```

Builds the Dockerfile on Fly's builders, starts one machine, waits for the
`/api/health` check. **The first build takes a while (10-25 min)**: the image
bakes the CPU-only torch stack plus the ~860MB FashionSigLIP checkpoint
(downloaded once at build time so boot never touches the network), and the
resulting multi-GB image has to be pushed to Fly's registry. Later deploys
reuse the cached ML layer and are much faster — only your app layers rebuild. The app is now up **with an empty database** — the
landing page works and the feed shows a clear empty state.

**Keep it at exactly one machine.** If Fly created two for redundancy:

```bash
fly scale count 1
```

(SQLite on a volume = single writer; a second machine would get an empty
volume and a duplicate crawler.)

## 5. Upload your database

Checkpoint the WAL locally first so the single `.db` file is complete:

```bash
sqlite3 data/hemline.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

Then upload over sftp (machine keeps running; the file swap is atomic enough
for a beta — do it before sharing the URL, or stop the machine first if you
want to be strict):

```bash
fly ssh sftp shell
» put data/hemline.db /data/hemline.db
» exit
fly apps restart hemline   # picks up the new file with a clean handle
```

## 6. Verify

```bash
curl -s https://hemline.fly.dev/api/health | python3 -m json.tool
```

Expect `"listingCount"` ≈ 1600+, `"vectorCount"` ≈ 1600+, and
`"ml": {"sidecarAvailable": true, "state": "ready"}`. The model eager-loads at
boot (5-20s): right after a deploy you may briefly see
`{"sidecarAvailable": false, "state": "warming"}` — poll again; if it ever
says `"failed"`, check `fly logs` for the `[startup] ml sidecar` lines.
Then open https://hemline.fly.dev in a phone-sized viewport, and try a photo
in "find dresses like this" — the response should say
`"matchBasis": "embedding"`.

Admin health (uses your basic-auth secret):

```bash
curl -s -u "admin:<password>" https://hemline.fly.dev/api/admin/ingest | python3 -m json.tool
```

## 7. Crawls in production

The scheduler runs **inside the machine** (one node-cron job per source,
Shopify/JSON-LD daily at 06:00 UTC, eBay 6-hourly) — no external cron needed.
Watch it:

```bash
fly logs                 # [scheduler] lines are the cron worker, [web] the server
```

Run a full one-shot crawl by hand (equivalent of `npm run ingest`):

```bash
fly ssh console -C "node /app/dist/ingest-run.mjs"
```

One store: `fly ssh console -C "node /app/dist/ingest-run.mjs --source=shopify:staud.clothing"`.
Or trigger through the API: `curl -X POST -u "admin:<password>" https://hemline.fly.dev/api/admin/ingest`.

New/changed listings get Haiku extraction (within `AI_DAILY_BUDGET_USD`)
**and FashionSigLIP vectors, automatically** — embed-on-ingest now runs in
production (local CPU compute, no API cost), so newly crawled dresses join
visual search and blended ranking without any manual `npm run embed` +
re-upload cycle. Look for `[embed] embedding N new/changed listing(s)` in the
logs after a crawl.

## 8. Fresh/empty volume behavior

If you ever start with an empty volume (new region, recreated volume): the
app boots fine, creates the schema, and shows an empty feed. To load the
150-listing fixture demo corpus + demo user instead:

```bash
fly ssh console -C "node /app/dist/seed.mjs"
```

(Uploading your real db per step 5 replaces all of that.)

## 9. Logs, rollback, day-2

```bash
fly logs                        # live tail
fly ssh console                 # shell inside the machine
fly releases                    # deploy history
fly deploy --image <ref>        # roll back: fly releases shows image refs
fly volumes snapshots list <volume-id>   # daily snapshots (5 kept)
fly volumes create --snapshot-id <id>    # restore = new volume from snapshot
fly ssh console -C "node -e 'console.log(process.env.DATABASE_PATH)'"
```

Config changes (`fly.toml [env]`) take effect on the next `fly deploy`;
secrets via `fly secrets set` restart the machine immediately.

## Cost expectations (2026-07 Fly pricing)

| Item | Monthly |
|---|---|
| shared-cpu-1x / 4GB, always on (scheduler + resident ML model) | $22.22 |
| Volume 3GB × $0.15 | $0.45 |
| Egress (beta traffic, NA/EU $0.02/GB) | ~$0–1 |
| **Fly total** | **~$23–24/mo** |
| Anthropic API (capped by `AI_DAILY_BUDGET_USD=5`) | $0–150 worst case; realistically **$1–10/mo** (extraction is cached by content hash; re-rank is cached 24h) |

(The no-ML option (b) config — 2GB VM, ~$11/mo — remains in git history if
the budget ever needs to shrink; see `docs/decisions-deploy.md` §2/§2a.)

## ML note: the FashionSigLIP sidecar ships in the image (option (a))

The production image bakes the full embedding stack: a CPU-only torch venv at
`/app/ml/.venv` plus the ~860MB Marqo-FashionSigLIP checkpoint in a
HuggingFace cache at `/app/ml/.hf` (`HF_HUB_OFFLINE=1` — boot never downloads
weights). The web server eager-loads the model at startup
(`HEMLINE_ML_EAGER=1`; `/api/health` reports `ml.state` warming → ready).
What that buys:

- **Visual photo/text search in prod:** "find dresses like this" embeds the
  probe with FashionSigLIP and answers `matchBasis: "embedding"` — the
  attribute path remains the automatic fallback if the sidecar ever fails.
- **Embed-on-ingest:** newly crawled listings get vectors automatically (see
  step 7) — no more local `npm run embed` + db re-upload cycle.
- **Blended feed ranking** keeps reading stored vectors as before (it never
  needed Python), now the vector set grows with every crawl.

Costs of the trade (accepted, `docs/decisions-deploy.md` §2a): a ~3.5GB
image (slower deploys — the ML layer is cached after the first), the 4GB VM
at $22.22/mo instead of 2GB at $10.70, and ~1.3GB of RSS for the resident
model — measured peak under load was 1.75GB, well within the 4GB VM.

Backup follow-up: Litestream streaming replication — scaffold in
`docker/litestream.yml`.