/**
 * Adaptive calibration deck (2026-07-10, docs/decisions-deck.md) —
 * mode-agnostic (real seeded API in the default config, mock layer in the
 * smoke variant):
 * - completion is positive-signal-driven: 5 likes/saves finish the deck
 *   immediately, hearts progress fills toward the target;
 * - the fallback path: a user who likes nothing gets encouraging extension
 *   batches (never blaming copy) and proceeds gracefully at the 30-card cap
 *   with honest "we'll keep learning" copy.
 */
import { test, expect, type Page } from '@playwright/test';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false });

/** Minimal quiz walk: 5'4", sizes 6/8, everything else skipped. */
async function onboardToDeck(page: Page) {
  await page.goto('/');
  await page.getByTestId('cta-start').click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole('button', { name: '5′', exact: true }).click();
  await page.getByRole('button', { name: '4″', exact: true }).click();
  await page.getByTestId('quiz-next').click(); // → 2 sizes
  await page.getByRole('button', { name: '6', exact: true }).click();
  await page.getByRole('button', { name: '8', exact: true }).click();
  await page.getByTestId('quiz-next').click(); // → 3
  for (let s = 3; s <= 7; s++) await page.getByTestId('quiz-next').click();
  await page.getByTestId('quiz-finish').click();
  await expect(page).toHaveURL(/\/calibrate/);
  await page.getByTestId('swipe-card').first().waitFor();
}

async function swipeTimes(page: Page, testId: string, times: number) {
  for (let i = 0; i < times; i++) {
    await page.getByTestId(testId).click();
    await page.waitForTimeout(330); // fling animation
  }
}

test('adaptive deck: 5 likes complete calibration immediately, hearts track likes not cards', async ({ page }) => {
  await onboardToDeck(page);

  // progress reflects LIKES toward the target, not raw card count
  const hearts = page.getByTestId('hearts-progress').last();
  await expect(hearts).toContainText('0 of 5');

  await swipeTimes(page, 'swipe-like', 2);
  await expect(hearts).toContainText('2 of 5');
  // 2 likes is not a style — the deck keeps going
  await expect(page.getByTestId('swipe-card')).toBeVisible();

  await swipeTimes(page, 'swipe-like', 2);
  await expect(hearts).toContainText('4 of 5');
  await shot(page, '12-deck-hearts');

  // 5th positive → auto-complete into the building state → feed
  await page.getByTestId('swipe-like').click();
  await expect(page.getByText('rack…', { exact: false })).toBeVisible();
  await expect(page.getByText('Personalizing for your height, size and taste.')).toBeVisible();
  await expect(page).toHaveURL(/\/feed/, { timeout: 20_000 });
});

test('adaptive deck fallback: zero likes → encouraging extension batches → graceful finish at the 30-card cap', async ({ page }) => {
  test.setTimeout(180_000);
  await onboardToDeck(page);

  // batch 1: pass on all 12 → warm interstitial, never blaming
  await swipeTimes(page, 'swipe-pass', 12);
  const interstitial = page.getByTestId('deck-interstitial');
  await expect(interstitial).toBeVisible();
  await expect(interstitial).toContainText('Still learning your style');
  await shot(page, '13-deck-still-learning');
  await page.getByTestId('deck-more').click();

  // batch 2 appended: 12 + 7 cards
  await expect(page.getByTestId('swipe-card')).toBeVisible();
  await expect(page.getByText('13 / 19')).toBeVisible();
  await swipeTimes(page, 'swipe-pass', 7);
  await expect(interstitial).toBeVisible();
  await page.getByTestId('deck-more').click();

  // batch 3: → 26
  await expect(page.getByText('20 / 26')).toBeVisible();
  await swipeTimes(page, 'swipe-pass', 7);
  await expect(interstitial).toBeVisible();
  await page.getByTestId('deck-more').click();

  // batch 4 trimmed to the cap: → 30
  await expect(page.getByText('27 / 30')).toBeVisible();
  await swipeTimes(page, 'swipe-pass', 3);
  await page.getByTestId('swipe-pass').click(); // 30th card → cap

  // graceful, honest completion copy — ambient feed swipes keep training
  await expect(page.getByText(/keep learning as you browse/)).toBeVisible();
  await shot(page, '14-deck-keep-learning');
  await expect(page).toHaveURL(/\/feed/, { timeout: 20_000 });
});
