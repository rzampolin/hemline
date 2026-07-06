import { defineConfig } from 'drizzle-kit';

// NOTE: drizzle-kit does not auto-load .env; DATABASE_PATH falls back to the
// default path from docs/ARCHITECTURE.md §9.1. Export DATABASE_PATH in your
// shell if you moved the db file.
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/src/migrations',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/hemline.db',
  },
});
