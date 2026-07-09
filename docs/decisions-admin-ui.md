# Decisions — Admin Dashboard UI (/admin)

2026-07-09 · founder-facing ops dashboard over the existing `/api/admin/*` JSON.

## What shipped

`/admin` (desktop-first, the one page in the app where that's true): catalog
overview header (listings / vectors / extraction coverage %), crawler health
table, extraction QA list with inline corrections, clickouts panel, and an
opportunistic Events panel. Client-side polling every 60s.

## Decisions

1. **Auth = HTTP Basic via `apps/web/middleware.ts`, same env gate as the API.**
   App Router pages can't emit a 401 + `WWW-Authenticate` challenge, so the
   page gate lives in middleware (matcher `['/admin', '/admin/:path*']` — the
   public app never passes through it). Semantics mirror
   `app/api/lib/admin-auth.ts` exactly: `ADMIN_BASIC_AUTH="user:pass"`
   required; unset → open in dev, DENIED (401, no challenge) in production.
   The API routes keep their own in-handler check untouched — defense in
   depth, and their bare-401 envelope behavior is unchanged. Because the
   authenticated path `/admin` has directory `/`, browsers re-send the cached
   credentials preemptively on the dashboard's same-origin `fetch`es to
   `/api/admin/*` (RFC 7617 §2.2) — no token plumbing needed. Verified against
   the production build: no/wrong creds → 401 + challenge, correct creds →
   page 200 and API 200.

2. **Instrumentation split (`instrumentation.ts` → `instrumentation-node.ts`).**
   Adding any middleware makes Next compile `instrumentation.ts` for the Edge
   runtime too, and its eager-ML-warmup path imports
   `@hemline/matching/embedder` → `node:child_process`, which broke the Edge
   build. Fixed with the documented Next pattern: top-level hook only does
   `if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node')`
   — webpack constant-folds the condition and skips the branch in the Edge
   bundle. The old early-`return` guard was NOT enough (webpack collects
   imports in dead code after a return). Startup behavior in the Node runtime
   is unchanged; no matching/ai/ingest code was touched.

3. **Additive `catalog` field on `GET /api/admin/ingest`** (read-only, cheap
   counts): `listings {total, active}`, `vectors {rows, embeddedListings}`,
   `extraction {extractedListings, lengthClassPct, lengthInchesPct, colorsPct}`.
   Coverage percentages use **active listings** as the denominator — that's
   the number founders reason about ("how much of the live catalog is
   enriched"). Implemented as `catalogOverview(db)` in
   `packages/db/src/query/admin.ts`; one grouped pass over extractions plus
   four count queries.

4. **Additive `imageUrl` on extraction-QA rows** — first listing image via a
   correlated subquery, so the QA panel can show thumbnails without an N+1 or
   a new endpoint. Plain `<img>` (not `next/image`): arbitrary remote hosts,
   internal tool, optimization pipeline not worth configuring.

5. **Enabled toggle is read-only.** The admin API exposes `enabled` on
   `SourceHealth` but has no write endpoint for it (POST /api/admin/ingest
   only triggers runs). Shown as a disabled `Toggle` with an explanatory
   subtitle rather than building a new write path.

6. **Events panel is opportunistic.** It probes `GET /api/admin/analytics` on
   each refresh; 404 hides it silently for the session (a parallel workstream
   may ship the endpoint — we render whatever lands, shape-agnostically:
   top-level numbers as stat tiles, the rest as compact JSON). We deliberately
   did not build the endpoint.

7. **Corrections stamp confidence.** The inline form defaults confidence to 1
   on save (a human looked at it), sends only changed fields, and swaps the
   returned row into the list in place. Colors/occasions aren't editable
   inline — array-of-object editing wasn't worth the form complexity for v1;
   the PATCH endpoint supports them if we ever need it.

8. **Styling** reuses `@hemline/ui` primitives (Button, Toggle, Spinner,
   Skeleton, ErrorState, cn, formatAgo) + the editorial theme tokens, in a
   dense utilitarian layout. Nothing admin-specific was added to packages/ui —
   the panel/table chrome is one-off and lives in `apps/web/app/admin/`.

## Tests

- Route: `catalog` aggregate shape + QA-row `imageUrl` (api.test.ts, additive).
- Middleware: challenge/pass/dev-open/prod-deny + matcher scope
  (`admin-page-auth.test.ts`).
- e2e: `e2e/admin.spec.ts` (real mode, 1280px viewport; skipped in mock mode)
  walks all panels, opens a correction form, and captures
  `e2e/screenshots/admin-dashboard.png`.

Baseline 712 → 719 tests, all green; lint/typecheck/`next build` clean.
