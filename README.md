# Hemline

Personal dress-shopping assistant (mobile-first web). Hemline aggregates in-stock dresses
from resale (eBay) + DTC Shopify brands, extracts structured attributes with the Claude
API, and personalizes results — including the moat: **effective length**, i.e. where each
hem actually falls on *your* body given your height.

- Product spec: [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)
- Architecture (authoritative): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Scaffold decisions / doc deviations: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Setup (zero keys required)

```bash
cp .env.example .env          # API keys optional — app runs in demo mode without them
npm install
npm run seed                  # = db:migrate + db:seed → creates data/hemline.db with 150 fixture dresses
npm run dev                   # Next.js on http://localhost:3000
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `next dev` for `apps/web` (API routes included) |
| `npm run build` / `start` | Production build / serve of `apps/web` |
| `npm run ingest` | One-shot ingest of all enabled sources *(stub — data-eng)* |
| `npm run ingest:watch` | Long-running node-cron scheduler *(stub — data-eng)* |
| `npm run db:migrate` | `drizzle-kit push` → creates/updates `data/hemline.db` |
| `npm run db:seed` | Loads fixtures: 150 listings + pre-baked extractions + demo profile + swipes |
| `npm run seed` | `db:migrate` + `db:seed` |
| `npm run db:studio` | Drizzle Studio DB browser |
| `npm test` | Vitest across all workspaces |
| `npm run test:e2e` | Playwright e2e *(stub — frontend-eng)* |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint |

## Ownership

Each owned directory has an `OWNER.md`. Cross-module types live in
`packages/contracts` (**frozen** — changes need a 4-party PR review). See
`docs/ARCHITECTURE.md` §2 for the full ownership map and §10 for build order.
