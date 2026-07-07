import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e — runs against the dev server in MOCK MODE
 * (NEXT_PUBLIC_API_MOCK=1): fixture-derived catalog, localStorage profile,
 * fully deterministic, zero keys/DB required. `npm run test:e2e` from root.
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
    command: 'npm run dev -w @hemline/web -- --port 3210',
    url: 'http://localhost:3210',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_MOCK: '1' },
  },
});
