import { defineConfig, devices } from '@playwright/test';

/**
 * Mock-mode smoke variant (`npm run test:e2e:mock`): same specs, client-side
 * mock layer (NEXT_PUBLIC_API_MOCK=1), no db needed. Kept cheap so the mock
 * layer can't silently rot behind the flag. Screenshots are shared with the
 * real-mode run — whichever ran last wins; refresh intentionally.
 */
export default defineConfig({
  testDir: '.',
  outputDir: './test-results-mock',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3211',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium-mock',
      use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev -w @hemline/web -- --port 3211',
    url: 'http://localhost:3211',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_MOCK: '1' },
  },
});
