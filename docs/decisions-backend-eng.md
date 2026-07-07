# Backend-eng decisions (API surface + db query layer)

Pragmatic calls made implementing `apps/web/app/api/**` and the additive
`packages/db` query layer, where docs/ARCHITECTURE.md / PRODUCT_SPEC.md were
ambiguous or the frozen contracts didn't cover a required feature. Companion
to docs/DECISIONS.md (week-0 scaffold decisions).

1. **Session = signed cookie, client UUID adopted via header.** The
   architecture doc says "signed httpOnly cookie → users row" (§1); the
   product spec says "client generates an anonymous profile UUID in
   localStorage" (A2). Reconciled: `GET /api/session` mints server-side and
   sets `hemline_session=<uuid>.<hmac-sha256(SESSION_SECRET)>`; if the client
   presents its own UUID via the `x-hemline-user-id` header it is adopted
   (row created if absent) and the signed cookie is set on the response.
   Cookie wins over header. All non-admin routes accept either.

2. **Stub-tolerant service pattern.** `packages/matching` and `packages/ai`
   throw "not yet implemented" in this worktree. Every call site wraps them in
   try/catch with a deterministic fallback implementing the *documented*
   formula:
   - `apps/web/app/api/lib/matching.ts` → `inlineHemForUser` is a verbatim
     copy of §5 (0.82 factor, heel×0.85, band table, class priors).
     **Integration cleanup: delete it once matching lands** — grep `INLINE`.
   - similarity = sparse cosine, freshnessDecay = exp(−ln2·age/halfLife)
     (7d ebay-kind / 21d otherwise), paletteBoost = 1.0–1.25 by color-family
     overlap, blend = 0.6/0.4 — all per §6.
   - re-rank: `import('@hemline/ai').rerank` attempted when
     `personalize:true`; on throw → deterministic order + templated
     `whyItWorks` (§7.5 degraded table). `rerank.mode` reports honestly.
   - color: `analyzeSelfie`/`classifyFromQuiz` attempted; fallbacks in
     `lib/color.ts` (quiz scoring table over warm/cool × depth × clarity —
     which §7.4 defines as deterministic-no-LLM even in live mode; selfie →
     deterministic season from a rule table keyed on sha256(image bytes),
     honest `caveat` + `sampleQuality:'poor'`). Selfie buffers are **never**
     written to disk/db; result is only persisted when the user PUTs.

3. **Doc §5 prose examples vs formula.** The worked example ("44″ dress …
   r=0.135 on 5'2″") doesn't reproduce with S=0.82·H (gives r=0.110); the
   prose seems to have used ≈0.845. The **formula is normative** — implemented
   exactly as specified; ai-eng should confirm when writing the exhaustive
   band table.

4. **Quiz → profile.** `POST /api/color-analysis/quiz` persists the resulting
   season+palette to the profile immediately (the deliverable's
   "QuizAnswers → profile"), and returns `ColorAnalysisResult` per the frozen
   contract; `PUT /api/color-analysis` still overrides. The selfie POST does
   **not** auto-persist (spec D1's "Does this look right?" confirm step).

5. **Saves have no table → save-verdict swipe rows.** Schema is frozen;
   `swipe_events.verdict='save'` already models a save. `POST /api/saves`
   inserts one (deduped), `DELETE /api/saves/:id` deletes the user's save
   rows for that listing, `GET /api/saves` returns hydrated `RankedListing`
   cards + `staleIds` ("possibly sold" per F1). `POST /api/swipes` with
   verdict 'save' lands on the rack too, as intended.

6. **Aux tables via CREATE TABLE IF NOT EXISTS (schema-change requests).**
   `pending_alerts` (spec F4 requires it; no email ever sent) and
   `extraction_corrections` (spec G2 correction log) are materialized lazily
   by their repos in `packages/db/src/query/{alerts,admin}.ts` — schema.ts
   untouched. **Request: adopt both into schema.ts + drizzle at the next
   4-party review** (DDL in those files).

7. **Manual extraction corrections stamp `model='manual'`.** Spec G2 says
   corrections override extraction on re-ingest; the extraction row is
   updated in place, previous values logged to `extraction_corrections`.
   **Integration note (data-eng): the ingest pipeline must skip re-extracting
   rows whose `model='manual'`.**

8. **Additive routes beyond the frozen §4.7 table** (contracts untouched;
   local Zod schemas in the routes, frozen shapes reused where they exist):
   - `GET /api/profile` (read-only convenience; PATCH per contract),
   - `GET /api/search` (spec B3 URL-shareable filter state → `RankResponse`;
     params incl. `lengthClass` label filter, `lengthOnBody` effective band,
     `sources`, `freshnessHours`; guest browse allowed, explicit filters only
     — unlike `/api/rank`, profile size/budget are not silently applied),
   - `GET|POST /api/saves`, `DELETE /api/saves/:listingId`,
   - `GET|POST /api/alerts`,
   - `POST /api/find-similar` (spec B4; multipart `photo` | JSON
     `{imageBase64|imageUrl|hint}` → attribute vector → cosine matches →
     `nearest` fallback; keyword-taxonomy fallback extractor while ai is
     stubbed, `extractionMode` reports which ran),
   - `GET /api/admin/ingest` (health, spec G1) alongside the contract's POST,
   - `GET /api/admin/extractions`, `PATCH /api/admin/extractions/:hash` (G2).

9. **Freshness windows by source kind.** Spec B1: 24h eBay / 48h Shopify;
   fixture sources get 96h (the seeded corpus spans 0–72h by design so the
   demo feed stays full). Search accepts `freshnessHours` (≤720) to widen.

10. **`POST /api/rank` applies profile hard filters silently** (her sizes +
    budget, spec B1) unless the request's filters override those keys.
    `lengthOnBody` filtering runs post-SQL over the ≤500 candidate cap
    because it's per-user math. Cursor = base64url offset into the
    deterministic ranking (stable given identical inputs); `limit` capped at
    100. Body `userId` is ignored when a session cookie/header is present.

11. **`POST /api/admin/ingest` records the run, doesn't crawl.** The pipeline
    is apps/ingest (data-eng) and not importable from web yet; the endpoint
    validates per contract, inserts an `ingest_runs` row
    (status='error', error='not_implemented…') and returns `{runId}` so the
    trigger is visible in G1. **Integration: swap to the shared pipeline
    entrypoint when data-eng exposes one.**

12. **Style-tag learning rule lives in the API layer**
    (`lib/style-learning.ts`): `styleTags[tag] += rate(verdict)·weight`,
    rates like +0.15 / save +0.25 / dislike −0.15 / skip −0.03, clamped
    [−1,1], near-zero pruned. Frozen matching surface has no learn(); move
    there later if ai-eng wants it.

13. **db package additions (all additive):** `src/query/*` repositories,
    `src/constants.ts` (DEMO_USER_ID, moved out of the self-executing
    seed), `src/ddl.ts` (§3 DDL as CREATE IF NOT EXISTS — lets tests build a
    temp db without shelling to drizzle-kit; dev flow still drizzle-kit
    push), and `seed.ts` refactored to an exported `runSeed(dbPath?)` with a
    main-module guard (`npm run db:seed` behavior unchanged).

14. **Admin auth:** HTTP Basic when `ADMIN_BASIC_AUTH="user:pass"` is set
    (spec G1 "env-var basic auth is fine"); open with a console warning in
    dev when unset.

15. **Web app db handle** (`lib/db.ts`): one cached better-sqlite3 connection
    (synchronous driver — §10 risk 4), found via $DATABASE_PATH or by walking
    up from cwd to `data/hemline.db` (next dev runs with cwd=apps/web).
    `ensureSchema` runs once at open (idempotent) so a keyless fresh clone
    can't crash on a missing table.
