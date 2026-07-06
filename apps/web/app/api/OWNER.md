# OWNER: backend-eng (route handlers only — pages are frontend-eng)

**Scope:** REST route handlers, thin: parse (Zod) → service → respond
(docs/ARCHITECTURE.md §4.7). Also owns `packages/db` and root
`drizzle.config.ts`.

## Endpoints to build (all shapes frozen in `@hemline/contracts`)
| Route | Contract |
|---|---|
| `GET /api/session` | mints anon user + signed httpOnly cookie → `UserProfile` |
| `PATCH /api/profile` | `ProfilePatchSchema` → `UserProfile` |
| `PUT /api/profile/brand-sizes` | `BrandSizesPutSchema` → `UserProfile` |
| `POST /api/swipes` | `SwipesPostSchema` → `{ styleTags }` |
| `POST /api/rank` | `RankRequestSchema` → `RankResponse` |
| `GET /api/listings/:id` | → `ListingDetailResponse` |
| `POST /api/color-analysis` | multipart selfie — in-memory only, never persisted |
| `POST /api/color-analysis/quiz` | `ColorAnalysisQuizRequestSchema` → `ColorAnalysisResult` |
| `PUT /api/color-analysis` | `ColorAnalysisPutSchema` → `UserProfile` |
| `GET /api/meta/filters` | → `MetaFiltersResponse` |
| `POST /api/admin/ingest` | `AdminIngestRequestSchema` → `{ runId }` |

Every response is `ApiResponse<T>`. `session/route.ts` is scaffolded as a 501
stub showing the pattern. better-sqlite3 is synchronous — prepared statements,
never in client components. Build order: session/profile → rank (deterministic
scoring first) → listings/detail → swipes → color (stub → ai-eng's service) →
admin/ingest (doc §10 track C).
