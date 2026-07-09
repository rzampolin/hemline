import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// ABSOLUTE path: the web server's cwd is apps/web, so a relative
// DATABASE_PATH would silently open an empty db there (apps/web/app/api/lib/db.ts
// resolves relative env paths against process.cwd()).
const E2E_DB = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'data', 'hemline-e2e.db');

/**
 * Playwright e2e — REAL MODE (integration 2026-07-06): dev server against the
 * seeded SQLite db, real API routes, keyless AI degradation. This is the
 * canonical experience (`npm run test:e2e`). The webServer command re-seeds
 * so runs are deterministic.
 *
 * ISOLATED DB (incident 2026-07-09): e2e runs against data/hemline-e2e.db,
 * NEVER the dev catalog at data/hemline.db — a re-seed once wiped 1,634
 * live-crawled listings + extractions + embeddings. DATABASE_PATH below is
 * load-bearing; do not remove it.
 *
 * Mock-mode smoke variant: `npm run test:e2e:mock` (playwright.mock.config.ts).
 */
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3210',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // Mobile-first product: 390px is the primary design target.
      name: 'mobile-chromium',
      use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run seed && npm run dev -w @hemline/web -- --port 3210',
    url: 'http://localhost:3210',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // real mode: NEXT_PUBLIC_API_MOCK unset
    env: { NEXT_PUBLIC_API_MOCK: '', DATABASE_PATH: E2E_DB },
  },
});
