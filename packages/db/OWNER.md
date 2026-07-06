# OWNER: backend-eng

**Scope:** Drizzle schema, migrations, db client factory, query helpers, seed loader.

- `src/schema.ts` mirrors the DDL in docs/ARCHITECTURE.md §3 **exactly** — it was
  reviewed by data-eng + ai-eng in week 1; treat it as near-frozen (schema changes
  need a heads-up to both).
- JSON columns are plain `TEXT`; validate with the Zod schemas from
  `@hemline/contracts` at the boundary.
- `better-sqlite3` is synchronous: keep it out of hot request paths via prepared
  statements and **never import this package into client components**.
- Migration workflow: `npm run db:migrate` (drizzle-kit push) for dev;
  `drizzle-kit generate` writes SQL files to `src/migrations/` when we need
  reviewable migrations (Postgres upgrade path).
