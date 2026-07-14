# Custom domain — exact steps once a name is chosen

Prepared 2026-07-13 (ops). Everything below assumes the domain is
`hemline.example` — substitute yours. Total time: ~15 minutes + DNS
propagation.

## 0. What's already parameterized (done in this prep)

An audit for `hemline.fly.dev` hardcodings found (2026-07-13):

- **App code: none.** The one absolute-URL surface (OG/social `metadataBase`
  in `apps/web/app/layout.tsx`) now reads `NEXT_PUBLIC_APP_URL` via
  `apps/web/lib/app-url.ts` (fallback `https://hemline.fly.dev`). Any future
  absolute URL (sitemap, robots, emails) must import `APP_URL` from there.
- **Config:** `NEXT_PUBLIC_APP_URL` is set in `fly.toml` **twice** — under
  `[build.args]` (client bundles inline `NEXT_PUBLIC_*` at build time) and
  `[env]` (server runtime). Keep them in lockstep.
- **Docs:** `DEPLOY.md` uses `hemline.fly.dev` in example `curl`s — cosmetic,
  update opportunistically.
- **Crawler identity:** the bot User-Agent is `HemlineBot/1.0
  (+$CRAWLER_CONTACT)` (packages/connectors politeness.ts, packages/ai
  images/fetcher.ts). `CRAWLER_CONTACT` is currently the founder email in
  `fly.toml` — see step 5.

## 1. Decide the canonical host (recommendation: apex + www redirect)

Recommendation: canonical = **`hemline.example`** (apex), with `www` served
too (Fly certs cover both) and left as a working alias — Fly has no built-in
redirect, and a middleware redirect is a 5-line follow-up if canonicalization
ever matters for SEO. Decide before step 3; the canonical host is what goes
into `NEXT_PUBLIC_APP_URL`.

## 2. DNS records (at your registrar)

Get the app's addresses: `fly ips list`

| Type | Name | Value |
|---|---|---|
| A | `@` | the IPv4 from `fly ips list` |
| AAAA | `@` | the IPv6 from `fly ips list` |
| CNAME | `www` | `hemline.fly.dev.` |

(If the registrar doesn't allow CNAME-at-apex, that's fine — the table above
never needs one.)

## 3. Certificates

```bash
fly certs add hemline.example
fly certs add www.hemline.example
fly certs show hemline.example      # wait for "Status: Ready" (usually minutes)
```

If `fly certs show` asks for a CNAME/TXT validation record, add exactly what
it prints, then re-check.

## 4. Point the app at the new canonical URL

Edit `fly.toml`, replacing BOTH values:

```toml
[build.args]
  NEXT_PUBLIC_APP_URL = "https://hemline.example"
[env]
  NEXT_PUBLIC_APP_URL = "https://hemline.example"
```

Then `fly deploy` (the build arg requires a rebuild — that's why it can't be
a `fly secrets set`).

## 5. Crawler contact / User-Agent

The polite-crawler UA advertises a contact (`HemlineBot/1.0 (+…)`). With a
real domain, switch from the personal email to a domain address or URL:

```bash
# in fly.toml [env]:
CRAWLER_CONTACT = "https://hemline.example/about-bot"   # or bot@hemline.example
```

Also update `.env.example` and `docs/ARCHITECTURE.md` §env for consistency.
No code change needed — both UA builders read the env var.

## 6. Update the monitoring + runbooks

- UptimeRobot monitor URL → `https://hemline.example/api/health`
  (docs/UPTIME.md).
- `DEPLOY.md` example curls (cosmetic).
- `ADMIN_BASIC_AUTH` browser sessions: nothing to do — auth is host-agnostic.

## 7. Verify

```bash
curl -sI https://hemline.example | head -3            # 200, no cert warnings
curl -s https://hemline.example/api/health | python3 -m json.tool
curl -sI https://www.hemline.example | head -3        # also serves
# OG tags carry the new origin:
curl -s https://hemline.example | grep -o 'hemline.example[^"]*' | head
```

`hemline.fly.dev` keeps working indefinitely (Fly's default cert) — old links
and the uptime monitor migration can be lazy.
