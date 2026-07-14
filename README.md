# Soline

Personal dress-shopping assistant (mobile-first web). Soline aggregates in-stock dresses
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
| `npm run ml:setup` | One-time: builds the local visual-embedding sidecar (see below) |
| `npm run embed` | Batch-embed catalog images with FashionSigLIP (local, $0) |

## ML setup (optional — real visual similarity)

One command builds a local Python sidecar running
[Marqo-FashionSigLIP](https://huggingface.co/Marqo/marqo-fashionSigLIP)
(Apache 2.0, open weights) for true image similarity + free-text visual search:

```bash
npm run ml:setup   # creates ml/.venv (~820 MB), downloads the model (~780 MB), ~5 min once
npm run embed      # embeds catalog images → vectors in SQLite (local compute, no API cost)
```

Requires python3 ≥ 3.10 (macOS arm64 uses torch's MPS backend automatically).
After that: "find dresses like this" photo uploads and text searches are ranked
by real visual similarity, and your like/save swipes build a visual style
profile that blends into feed ranking (60/40 with the attribute score).

**Everything works without it.** No python, no venv, no vectors → the app
degrades exactly like the keyless-AI story: find-similar uses Claude/rule-based
attribute extraction + sparse tag cosine, and ranking uses attribute vectors
only. `npm run embed` will just tell you to run `npm run ml:setup`.
Fixture listings use placeholder images and are deliberately never embedded —
visual search covers real ingested listings.

## Deploying

Production runs on Fly.io as a single machine (web + ingest scheduler in one
container, SQLite on a volume). Founder-runnable steps: **[DEPLOY.md](DEPLOY.md)**;
rationale: `docs/decisions-deploy.md`. Local check: `docker build -t hemline .`

## Ownership

Each owned directory has an `OWNER.md`. Cross-module types live in
`packages/contracts` (**frozen** — changes need a 4-party PR review). See
`docs/ARCHITECTURE.md` §2 for the full ownership map and §10 for build order.
