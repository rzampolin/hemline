# Soline — Security Review (2026-07-14)

Pragmatic breadth-first audit of the deployed app (Next.js 15 monorepo, Fly.io,
soline.io). Scope: close two rate-limit gaps + a broad "no leaked secrets / no
obvious holes" pass. Fixes applied directly on `main`; risky/ambiguous items are
reported here for a founder decision rather than changed unilaterally.

## Headline answer: are any secrets exposed?

**NO.** No secret is exposed in source, git history, or the client bundle.

- `.env` is gitignored and **has never been committed** (`git log --all -- .env`
  is empty). The real `ANTHROPIC_API_KEY` / eBay creds live only in the local
  gitignored `.env` and in Fly secrets.
- Full git-history grep for `sk-ant-…`, `AKIA…` (AWS), `ADMIN_BASIC_AUTH=<value>`,
  `SESSION_SECRET=<value>`, `AWS_SECRET_ACCESS_KEY=<value>` found **only**
  placeholders/docs (`"user:pass"`, `sk-ant-x` test literal, `openssl rand`
  command lines) — no live credential.
- `.env.example` contains only empty keys / placeholders (`change-me-…`).
- Client bundle: the only `NEXT_PUBLIC_*` vars are `NEXT_PUBLIC_APP_URL` and
  `NEXT_PUBLIC_API_MOCK` — both non-secret by nature. No secret is prefixed
  `NEXT_PUBLIC_`. Server-only modules (`@hemline/db`, `@hemline/ai`, session
  secret) are imported only from route handlers / server code, never a client
  component.

---

## Part A — Rate-limit gaps (CLOSED)

The in-memory limiter (`apps/web/app/api/lib/rate-limit.ts`, prod-only unless
`RATE_LIMIT_FORCE=1`) now guards every paid path plus the main DB-write abuse
surfaces.

### Coverage table (every LLM / embedding / vision / DB-write route)

| Route | Paid call | Before | After | Key |
|---|---|---|---|---|
| `POST /api/rank` | Haiku re-rank (personalize) | 20/min | 20/min (unchanged) | userId |
| `GET /api/search` | Haiku query-parse + query embed (stage 3, only when `q` present) | **none** | **60/min fast path + 15/min `q` bucket** | userId **or per-IP** |
| `POST /api/find-similar` | Haiku extraction / SigLIP | 10/min | 10/min | userId |
| `POST /api/color-analysis` | Sonnet selfie classify | 5/min | 5/min | userId |
| `POST /api/color-analysis/quiz` | none (deterministic) | **none** | **20/min** | userId |
| `POST /api/fit-check` | Haiku + SSRF fetch | 10/min | 10/min | userId (minted) |
| `POST /api/events` | none (analytics insert) | 30/min | 30/min | userId ?? anonId |
| `POST /api/clickouts` | none (DB write) | **none** | **60/min** | userId **or per-IP** |
| `POST /api/swipes` | none (DB write) | **none** | **120/min** | userId |
| `POST /api/saves` | none (DB write) | **none** | **120/min** | userId |

### Search — the important one

`/api/search` had **no** rate limit and makes LLM/embedding calls whenever a
free-text `q` is present (`apps/web/app/api/lib/search.ts` stage 3 = Haiku query
parse; stage 2 = query embedding). Two-tier fix (`apps/web/app/api/search/route.ts`):

- **`search` bucket, 60/min** — the deterministic keyword/filter fast path
  (high-traffic, cheap; this is just a DB-scrape guard).
- **`search-query` bucket, 15/min** — engages only when `q` is non-empty, i.e.
  the only path that can trigger stage-3 spend. Tighter cap on the wallet.

### Guest keying — fixed the "one global bucket" problem

Guests have no `userId`. Keying only by userId would put **all** guests in one
shared bucket (either trivially DoS-able or useless). New helper
`rateLimitKey(req)` (`apps/web/app/api/lib/session.ts`) returns the session user
when present, else `ip:<addr>` so guests are throttled **per-IP**.

### x-forwarded-for trust on Fly — done correctly

`clientIp(req)` derivation order: **`Fly-Client-IP`** → rightmost `X-Forwarded-For`
hop → `x-real-ip` → `unknown`.

- On Fly, `Fly-Client-IP` is stamped by the edge proxy and **cannot be forged**
  by the client — it is the correct primary source.
- `X-Forwarded-For` is client-appendable: a caller can send its own XFF and Fly
  *appends* the real hop, so the **leftmost** entries are attacker-controlled.
  We therefore take the **rightmost** entry (the trusted proxy hop), never
  `split(',')[0]`. A naive leftmost parse would let one abuser masquerade as
  unlimited distinct IPs and defeat the per-IP limit.

Tests: `apps/web/app/api/__tests__/rate-limit.test.ts` (7 tests, run under
`RATE_LIMIT_FORCE=1`) cover the `q` bucket 429, per-IP isolation (two guest IPs
don't share a bucket), the fast path staying open, the quiz cap, and the
Fly/XFF derivation incl. the spoofed-leftmost case.

---

## Part B — Audit findings (by severity)

### P0 — none

No committed live secret, no fail-open auth, no unauthenticated admin surface.

### P1 — trusted `x-hemline-user-id` header (IDOR by design) — FOUNDER DECISION

**File:** `apps/web/app/api/lib/session.ts:68-74` (`resolveUserId`) and `:86-91`
(`ensureSessionUser`).

The session model is passwordless "local-first" (spec A2): the user is a
client-minted UUID. Auth precedence is **signed cookie → then the unsigned
`x-hemline-user-id` header** (any syntactically-valid UUID is adopted).

Consequence: because a *raw* UUID in the header is trusted, the HMAC-signed
cookie provides **no forgery protection** — anyone who learns another user's
UUID can read/modify that user's profile, saves, and swipes by sending
`x-hemline-user-id: <victim-uuid>`. This is IDOR, but it is also the documented
capability model (the UUID *is* the bearer credential; 122 random bits make
guessing infeasible).

Why it's not a blind fix: removing header trust breaks the intended first-touch
client flow (localStorage UUID presented before any cookie exists). This is a
design call, so it is reported, not ripped out.

**Recommended (pick one):**
1. Treat the UUID as a true secret: guarantee it never lands in server logs,
   `Referer`, analytics, or shareable URLs, and document it as bearer-token-grade.
   (Cheapest; keeps the flow.) — **or —**
2. Trust the header only on the session-mint route (`GET /api/session`) and the
   first adopt, and require the signed cookie on all *mutation* routes
   (profile PATCH, saves, swipes) in production. This restores the point of the
   HMAC. Needs a client change (call `/api/session` first, then rely on cookie).

### P1 — `drizzle-orm` < 0.45.2 SQL-injection advisory (GHSA-gpj5-g38j-94v9) — FOUNDER DECISION

`npm audit --omit=dev`: **1 high**. The advisory is about improperly escaped SQL
**identifiers** (column/table names). In this codebase all identifiers are static
schema references and all user input is bound via Drizzle `${}` parameters
(verified — see "Injection" below), so practical exploitability here is low. The
fix (`drizzle-orm@0.45.2`) is flagged **breaking** by npm, so it is **not**
applied blindly. Recommend the founder schedule the bump and re-run the suite.

### P2 — non-constant-time admin basic-auth compare

**Files:** `apps/web/app/api/lib/admin-auth.ts:33` (`decoded === expected`) and
`apps/web/middleware.ts:31` (`atob(...) === expected`).

Both compare the supplied basic-auth string with `===`, which short-circuits and
is technically timing-observable. Low real-world severity (network jitter dwarfs
the signal; the secret is a shared ops password, not per-user). Fail-closed
behavior is otherwise **correct**: a missing `ADMIN_BASIC_AUTH` returns 401 in
production (verified in both the Node helper and the Edge middleware). Recommend
a `timingSafeEqual` in the Node helper when convenient; the Edge middleware
cannot easily use node:crypto, so leave or move the gate to the Node layer.

### P2 — `postcss` < 8.5.10 (moderate, dev/build only)

From `npm audit`: XSS in PostCSS's CSS stringifier — a **build-time** transitive
dep of Next, not attacker-reachable at runtime. npm's suggested "fix" downgrades
Next and is wrong. Ignore until the next Next upgrade carries it.

### P2 — analytics/events keyed partly by client-supplied `anonId`

**File:** `apps/web/app/api/events/route.ts:50`. Guests are rate-limited by
`anonId` (client-controlled), so a determined abuser can rotate `anonId` to
evade the 30/min cap. The body-size cap + closed event whitelist bound the
damage. Recommend adding the per-IP fallback (`rateLimitKey`) here too if
analytics spam ever shows up. Not changed now to keep the beacon path untouched.

### Cleared / confirmed-good

- **Admin auth on all routes:** `checkAdminAuth` is present on every
  `/api/admin/*` handler (analytics, errors, extractions, `extractions/[hash]`,
  ingest GET+POST) and the `/admin` page is gated by `middleware.ts`. Missing
  secret ⇒ 401 in prod (fail-closed). ✅
- **SQL injection:** all user-facing Drizzle queries use `${}` parameter binding
  (`packages/db/src/query/*`). The only `sql.raw` calls (`packages/db/src/ddl.ts`)
  operate on static schema literals — `PRAGMA table_info(${mig.table})` where
  `mig.table` is a hardcoded constant. No user input reaches raw SQL. ✅
- **XSS:** zero `dangerouslySetInnerHTML` in the codebase; React escapes by
  default. Stored free-text (search `q`, analytics props) is never rendered as
  raw HTML. ✅
- **SSRF (fit-check):** `apps/web/app/api/lib/safe-url.ts` is genuinely used by
  fit-check (via `apps/web/app/api/lib/fit-check.ts`) for the PDP fetch, robots,
  and any JS-rendered fetch. It enforces https-only, default-port-only, no URL
  creds, blocked hostnames, IPv4+IPv6 private/reserved/link-local (incl.
  `169.254.169.254` metadata and IPv4-mapped IPv6), DNS resolution with
  **every** resolved A/AAAA checked (DNS-rebinding), manual redirect following
  with per-hop re-validation, a streamed byte cap, and a hard timeout. Solid. ✅
- **Session cookie:** `httpOnly: true`, `sameSite: 'lax'`, `path:'/'`,
  HMAC-signed (`SESSION_SECRET`), verified with `timingSafeEqual`. Note: the
  cookie is **not** explicitly `Secure` — in production it is set over HTTPS so
  browsers scope it accordingly, but adding `secure: process.env.NODE_ENV ===
  'production'` on `attachSessionCookie` would be belt-and-suspenders (minor;
  not applied to avoid breaking local http dev without a guard). See below.
- **Health endpoint:** public, returns only counts/status/ages and error
  *counts* (no messages/stacks). No secrets. ✅
- **Error responses:** `serverError` returns `err.message` (not stack) in the
  envelope and records full detail server-side only. Messages are app-authored;
  low leak risk. Acceptable.
- **Input validation:** every mutating route Zod-validates at the boundary
  (`RankRequestSchema`, `BoundedProfilePatchSchema`, `SearchParamsSchema`,
  `AnalyticsBatchSchema`, `FitCheckRequestSchema`, etc.) with size caps on
  uploads/bodies. ✅

---

## Fixes applied in this pass

1. **Rate limits** (Part A): `search` (60 + 15/`q`, per-IP for guests), `quiz`
   (20), `clickouts` (60, per-IP), `swipes` (120), `saves` (120).
2. **`clientIp` / `rateLimitKey` helpers** with Fly-correct, non-spoofable IP
   derivation (`apps/web/app/api/lib/session.ts`).
3. **Baseline security headers** on every response (`apps/web/next.config.ts`):
   `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, CSP
   `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`,
   `Permissions-Policy` (geo/mic/camera off), HSTS 1y. A full script/style CSP
   is **not** added — Next's inline runtime needs nonces/hashes; tracked as a
   follow-up so we don't ship a broken page.
4. **Tests**: `apps/web/app/api/__tests__/rate-limit.test.ts` (7).

## Needs founder decision (not changed)

- P1 `x-hemline-user-id` trusted-header IDOR — pick option 1 or 2 above.
- P1 `drizzle-orm` 0.45.2 breaking upgrade.
- P2 constant-time admin compare; cookie `Secure` flag; analytics per-IP key.

## Gate status

- Full suite: **1111 passed** (1104 baseline + 7 new). ✅
- Lint (changed files): clean. ✅
- Typecheck: my changes add **zero** new errors. One **pre-existing** error
  remains (`apps/web/app/api/__tests__/admin-extractions.test.ts:38` —
  `Property '$client' does not exist on type 'Db'`), confirmed present on
  baseline (`git stash` check) and unrelated to this work.
