/**
 * Happy path (mode-agnostic — real seeded API in the default config, mock
 * layer in the smoke variant): landing → quiz completion → swipe calibration
 * → feed renders cards with hem badges → detail (hem module + affiliate CTA)
 * → save → My Rack. Screenshots land in e2e/screenshots/.
 */
import { test, expect, type Page } from '@playwright/test';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false });

test('landing → quiz → swipe → feed → detail → save', async ({ page }) => {
  /* ── landing ── */
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Dresses that actually fit');
  await expect(page.getByText('It’s a midi on you', { exact: false })).toBeVisible();
  // marketing polish 2026-07-13: stats band + privacy one-liner sell the differentiators
  await expect(page.getByTestId('stats-band')).toContainText('12,800+');
  await expect(page.getByTestId('privacy-line')).toContainText('No account');
  await shot(page, '01-landing');

  /* ── quiz (8 screens, 5'4" size 6/8) ── */
  await page.getByTestId('cta-start').click();
  await expect(page).toHaveURL(/\/onboarding/);

  // 1: height — cannot proceed until picked
  await expect(page.getByTestId('quiz-next')).toBeDisabled();
  await page.getByRole('button', { name: '5′', exact: true }).click();
  await page.getByRole('button', { name: '4″', exact: true }).click();
  await expect(page.getByText('5′4″ — got it')).toBeVisible();
  await shot(page, '02-quiz-height');
  await page.getByTestId('quiz-next').click();

  // 2: sizes
  await expect(page.getByText('2 of 8')).toBeVisible();
  await page.getByRole('button', { name: '6', exact: true }).click();
  await page.getByRole('button', { name: '8', exact: true }).click();
  await page.getByTestId('quiz-next').click();

  // 3: reference brands + inline size stepper
  await page.getByRole('button', { name: 'Reformation' }).click();
  await expect(page.getByLabel('Increase Reformation size')).toBeVisible();
  await page.getByRole('button', { name: 'STAUD' }).click();
  await page.getByTestId('quiz-next').click();

  // 4: avoid list
  await page.getByRole('button', { name: 'Mini / micro lengths' }).click();
  await page.getByTestId('quiz-next').click();

  // 5: budget with live count
  await expect(page.getByText('in-stock dresses')).toBeVisible();
  await shot(page, '03-quiz-budget');
  await page.getByTestId('quiz-next').click();

  // 6: vibes (optional) — pick one, then skip occasions
  await page.getByRole('button', { name: /Romantic/ }).click();
  await page.getByTestId('quiz-next').click();
  await page.getByRole('button', { name: 'Skip' }).click();

  // 8: transition
  await expect(page.getByText('Let’s calibrate your taste.')).toBeVisible();
  await page.getByTestId('quiz-finish').click();

  /* ── swipe calibration ── */
  await expect(page).toHaveURL(/\/calibrate/);
  await expect(page.getByTestId('swipe-card').first()).toBeVisible();
  // every deck card carries the effective-length line
  await expect(
    page.getByTestId('swipe-card').getByTestId('hem-badge').first(),
  ).toBeVisible();
  await shot(page, '04-swipe-deck');

  for (let i = 0; i < 6; i++) {
    const verdicts = ['swipe-like', 'swipe-pass', 'swipe-like', 'swipe-save', 'swipe-like', 'swipe-like'];
    await page.getByTestId(verdicts[i]).click();
    await page.waitForTimeout(320); // fling animation
  }
  // 5 likes/saves collected → adaptive deck auto-completes (2026-07-10)
  await expect(page.getByText('rack…', { exact: false })).toBeVisible(); // building state

  /* ── feed ── */
  await expect(page).toHaveURL(/\/feed/, { timeout: 15_000 });
  const cards = page.getByTestId('product-card');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThanOrEqual(4);

  // THE MOAT: every card has a hem badge, never blank
  const badges = page.getByTestId('hem-badge');
  expect(await badges.count()).toBeGreaterThanOrEqual(cardCount);
  const badgeTexts = await badges.allTextContents();
  for (const t of badgeTexts.slice(0, cardCount)) {
    expect(t).toMatch(/on you|Length unverified/);
  }
  await shot(page, '05-feed');

  /* ── filters ── */
  await page.getByTestId('open-filters').click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  await shot(page, '06-filter-sheet');
  await page.getByRole('button', { name: 'Resale (eBay)' }).click();
  await page.getByTestId('apply-filters').click();
  await expect(page).toHaveURL(/src=resale/);
  await expect(cards.first()).toBeVisible();
  // clear the source filter again for a full detail pick
  await page.getByTestId('open-filters').click();
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByTestId('apply-filters').click();

  /* ── detail ── */
  await cards.first().getByRole('link').click();
  await expect(page).toHaveURL(/\/dress\//);
  await expect(page.getByTestId('hem-module')).toBeVisible();
  await expect(page.getByTestId('hem-detail-line')).toContainText(/on you|length/i);
  await expect(page.getByTestId('shop-cta')).toBeVisible();
  await expect(page.getByTestId('shop-cta')).toHaveAttribute('target', '_blank');
  await shot(page, '07-detail');

  /* ── save from detail → My Rack ── */
  await page.getByRole('button', { name: 'Save to rack' }).first().click();
  await page.goto('/saved');
  await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '08-saved');
});

test('/about renders the full story; landing + about desktop/mobile shots', async ({ page }) => {
  /* ── about (mobile-first viewport from the project config) ── */
  const res = await page.goto('/about');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('How Hemline works');
  await expect(page.getByRole('heading', { name: 'The hem math, in plain language' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Privacy, plainly' })).toBeVisible();
  await shot(page, 'about-mobile');

  /* ── desktop shots ── */
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/about');
  await shot(page, 'about-desktop');
  await page.goto('/');
  await expect(page.getByTestId('stats-band')).toBeVisible();
  await shot(page, 'landing-desktop');
});
