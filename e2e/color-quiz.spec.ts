/**
 * Color quiz fallback (mode-agnostic — runs against the real API in the
 * default config, mock layer in the smoke variant): manual quiz → season
 * result → confirm → palette saved to profile → feed shows the removable
 * palette boost chip.
 */
import { test, expect } from '@playwright/test';

test('color quiz fallback → palette on profile → boost chip in feed', async ({ page }) => {
  // fresh browser context = fresh anonymous session in both modes
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());

  await page.goto('/color-analysis');
  await expect(page.getByText('analyzed, then deleted', { exact: false })).toBeVisible();
  await page.getByTestId('quiz-fallback').click();

  await expect(page).toHaveURL(/\/color-analysis\/quiz/);
  // warm + deep answers → dark autumn in BOTH scoring tables (real quiz table
  // in packages/ai and the mock layer), deterministically
  await page.getByRole('button', { name: 'Green or olive' }).click();
  await page.getByRole('button', { name: 'Gold', exact: true }).click();
  await page.getByRole('button', { name: /Soft cream/ }).click();
  await page.getByRole('button', { name: 'Almost never burns' }).click();
  await page.getByRole('button', { name: 'Dark brown', exact: true }).click();
  await page.getByRole('button', { name: 'Brown', exact: true }).click();

  await expect(page.getByTestId('season-name')).toContainText('Autumn', { timeout: 15_000 });
  await page.screenshot({ path: 'e2e/screenshots/09-color-result.png' });

  await page.getByTestId('confirm-season').click();
  await expect(page.getByText('Saved to your profile')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download my palette card' })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/10-palette-card.png' });

  await page.getByTestId('palette-to-feed').click();
  await expect(page).toHaveURL(/\/feed/);
  await expect(page.getByText('boosting your palette')).toBeVisible();

  // profile page shows the saved season + palette, editable
  await page.goto('/profile');
  await expect(page.getByText('Dark Autumn')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust' })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/11-profile.png', fullPage: true });
});
