/**
 * /admin dashboard smoke (2026-07-09) — real mode only: the panels are fed by
 * /api/admin/* against the seeded e2e db (mock mode has no admin layer).
 * ADMIN_BASIC_AUTH is unset in the e2e web server, so the middleware is open
 * (dev semantics); the auth gate itself is unit-tested in
 * apps/web/app/api/__tests__/admin-page-auth.test.ts.
 * Desktop viewport on purpose — the one desktop-first page in the app.
 */
import { test, expect } from '@playwright/test';

test.describe('admin dashboard', () => {
  test.skip(() => test.info().project.name.includes('mock'), 'real mode only');
  test.use({ viewport: { width: 1280, height: 900 } });

  test('renders crawler health, catalog overview, QA list, clickouts', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Hemline Ops' })).toBeVisible();

    // catalog overview header (additive aggregate)
    await expect(page.getByText('Active listings', { exact: true })).toBeVisible();
    await expect(page.getByText('Length class', { exact: true })).toBeVisible();

    // crawler health table: seeded fixture sources appear with freshness
    const health = page.getByRole('heading', { name: 'Crawler health' });
    await expect(health).toBeVisible();
    await expect(page.getByText('fixture:shopify').first()).toBeVisible();

    // extraction QA: rows load; opening one reveals the correction form
    await expect(page.getByRole('heading', { name: 'Extraction QA' })).toBeVisible();
    const firstConfidence = page
      .locator('table')
      .nth(1)
      .locator('tbody tr')
      .first();
    await expect(firstConfidence).toBeVisible();
    await firstConfidence.click();
    await expect(page.getByRole('button', { name: 'Save correction' })).toBeVisible();

    // clickouts panel
    await expect(page.getByRole('heading', { name: 'Clickouts' })).toBeVisible();

    // Events panel is optional: absent unless /api/admin/analytics exists
    await page.screenshot({ path: 'e2e/screenshots/admin-dashboard.png', fullPage: true });
  });
});
