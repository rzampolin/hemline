/**
 * QA spec-conformance walkthrough (2026-07-06) — PRODUCT_SPEC as test oracle.
 *
 * Mode-agnostic where possible; API-level assertions (hem formula cross-check,
 * palette-parity, stale-save flag) run in real mode only, where the seeded
 * SQLite db + real routes are behind the page. Screenshots → e2e/screenshots/qa/.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';

const SHOT_DIR = 'e2e/screenshots/qa';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

const isMock = () => test.info().project.name.includes('mock');

/* ── §5 formula mirrored for independent cross-checking ──────────────────── */
const PRIOR: Record<string, number> = {
  micro: 30, mini: 33, above_knee: 36, knee: 39, midi: 44, mid_calf: 47, maxi: 55, floor: 60,
};
function expectedHem(lengthInches: number | null, lengthClass: string | null, heightInches: number) {
  const L = lengthInches ?? (lengthClass ? PRIOR[lengthClass] : null);
  if (L == null) return null;
  const r = (0.82 * heightInches - L) / heightInches;
  if (r > 0.42) return 'upper_thigh';
  if (r > 0.31) return 'above_knee';
  if (r > 0.26) return 'knee';
  if (r > 0.2) return 'below_knee';
  if (r > 0.12) return 'mid_calf';
  if (r > 0.03) return 'ankle';
  return 'floor';
}

/* ── quiz walk helper ────────────────────────────────────────────────────── */
async function onboard(page: Page, feet: number, inch: number, opts: { toFeed?: boolean } = {}) {
  await page.goto('/');
  await page.getByTestId('cta-start').click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole('button', { name: `${feet}′`, exact: true }).click();
  await page.getByRole('button', { name: `${inch}″`, exact: true }).click();
  await page.getByTestId('quiz-next').click(); // → 2
  await page.getByRole('button', { name: '6', exact: true }).click();
  await page.getByRole('button', { name: '8', exact: true }).click();
  await page.getByTestId('quiz-next').click(); // → 3 brands (skippable)
  await page.getByTestId('quiz-next').click(); // → 4 avoid
  await page.getByTestId('quiz-next').click(); // → 5 budget
  await page.getByTestId('quiz-next').click(); // → 6 vibes
  await page.getByTestId('quiz-next').click(); // → 7 occasions
  await page.getByTestId('quiz-next').click(); // → 8
  await page.getByTestId('quiz-finish').click();
  await expect(page).toHaveURL(/\/calibrate/);
  if (opts.toFeed === false) return;
  await page.getByTestId('swipe-card').first().waitFor();
  for (let i = 0; i < 6; i++) {
    await page.getByTestId(i % 3 === 1 ? 'swipe-pass' : 'swipe-like').click();
    await page.waitForTimeout(330);
  }
  await page.getByTestId('deck-done').click();
  await expect(page).toHaveURL(/\/feed/, { timeout: 20_000 });
  await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 20_000 });
}

/* ═══ A1 quiz conformance ═══════════════════════════════════════════════ */

test('quiz: ≤8 screens, progress everywhere, back preserves answers, no account wall', async ({ page }) => {
  const started = Date.now();
  await page.goto('/');
  // A2: no signup wall anywhere on the entry path
  await expect(page.getByText(/sign in|log in|sign up|create account/i)).toHaveCount(0);
  await page.getByTestId('cta-start').click();

  // screen 1: progress + hard constraint (can't proceed without height)
  await expect(page.getByText('1 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-next')).toBeDisabled();
  await page.getByRole('button', { name: '5′', exact: true }).click();
  await page.getByRole('button', { name: '4″', exact: true }).click();
  await expect(page.getByText('5′4″ — got it')).toBeVisible();
  await page.getByTestId('quiz-next').click();

  // screen 2: progress + size constraint
  await expect(page.getByText('2 of 8')).toBeVisible();
  await expect(page.getByTestId('quiz-next')).toBeDisabled();
  await page.getByRole('button', { name: '6', exact: true }).click();

  // back nav preserves screen-1 answers
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText('1 of 8')).toBeVisible();
  await expect(page.getByText('5′4″ — got it')).toBeVisible();
  await page.getByTestId('quiz-next').click();
  // …and screen-2 answers survived the round-trip
  await expect(page.getByRole('button', { name: '6', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('quiz-next').click();

  // screens 3–7 all show progress and a Skip affordance (non-constraint)
  for (let s = 3; s <= 7; s++) {
    await expect(page.getByText(`${s} of 8`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
  }
  await expect(page.getByText('8 of 8')).toBeVisible();
  await page.getByTestId('quiz-finish').click();
  await expect(page).toHaveURL(/\/calibrate/);
  // no account/email was ever requested; happy path is well under 2 minutes
  expect(Date.now() - started).toBeLessThan(120_000);
});

/* ═══ C2 THE SIGNATURE FEATURE: same dress, different hem per height ══════ */

test('signature: petite 4\'11" vs tall 6\'0" see different hems on the SAME dress (card + detail + diagram)', async ({ page, browser }) => {
  test.setTimeout(180_000);
  // profile A: petite 4'11"
  await onboard(page, 4, 11);
  const firstCard = page.getByTestId('product-card').first();
  const cardBadgePetite = (await firstCard.getByTestId('hem-badge').textContent())!.trim();
  const href = await firstCard.getByRole('link').first().getAttribute('href');
  expect(href).toMatch(/\/dress\//);
  const title = (await firstCard.locator('p').first().textContent())!.trim();

  await firstCard.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/dress\//);
  await expect(page.getByTestId('hem-module')).toBeVisible();
  const detailPetite = (await page.getByTestId('hem-detail-line').textContent())!.trim();
  // the hem diagram (vertical body SVG with hem line) renders
  await expect(page.getByTestId('hem-module').locator('svg').first()).toBeVisible();
  await shot(page, 'sig-petite-detail');

  // profile B: tall 6'0" in an isolated context (fresh cookies/localStorage)
  const ctxTall = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tall = await ctxTall.newPage();
  await onboard(tall, 6, 0);

  // same dress, tall profile: detail page
  await tall.goto(href!);
  await expect(tall.getByTestId('hem-module')).toBeVisible();
  const detailTall = (await tall.getByTestId('hem-detail-line').textContent())!.trim();
  await expect(tall.getByTestId('hem-module').locator('svg').first()).toBeVisible();
  await shot(tall, 'sig-tall-detail');

  // same dress's CARD in the tall feed (search by title so it surfaces)
  const q = title.split(/[—–-]/)[0].trim();
  await tall.goto(`/feed?q=${encodeURIComponent(q)}`);
  const tallCard = tall.getByTestId('product-card').filter({ hasText: q }).first();
  let cardBadgeTall: string | null = null;
  if (await tallCard.isVisible().catch(() => false)) {
    cardBadgeTall = (await tallCard.getByTestId('hem-badge').textContent())!.trim();
  }

  // THE MOAT: 13 inches of height difference must move the hem copy
  expect(detailTall).not.toBe(detailPetite);
  if (cardBadgeTall) expect(cardBadgeTall).not.toBe(cardBadgePetite);

  // §5 formula cross-check on 3 listings (real API only)
  if (!isMock()) {
    for (const [p, height] of [[page, 59], [tall, 72]] as const) {
      const res = await p.request.post('/api/rank', {
        data: { userId: 'cookie', filters: {}, limit: 30, personalize: false },
      });
      expect(res.ok()).toBeTruthy();
      const { data } = await res.json();
      const withHem = data.items.filter((i: { hem: { position: string | null } }) => i.hem.position);
      expect(withHem.length).toBeGreaterThanOrEqual(3);
      for (const item of withHem.slice(0, 3)) {
        const want = expectedHem(item.listing.lengthInches, item.listing.lengthClass, height);
        expect(item.hem.position, `listing ${item.listing.id} at ${height}"`).toBe(want);
      }
    }
  }
  await ctxTall.close();
});

/* ═══ E1 swipe deck ═══════════════════════════════════════════════════════ */

test('swipe deck: 10–15 real cards, like/pass work, transitions to feed', async ({ page }) => {
  await onboard(page, 5, 4, { toFeed: false });
  await page.getByTestId('swipe-card').first().waitFor();
  // deck size surfaced as "1 / N" — spec says 10–15
  const counter = (await page.getByText(/^\s*1 \/ \d+\s*$/).textContent())!;
  const deckSize = Number(counter.split('/')[1].trim());
  expect(deckSize).toBeGreaterThanOrEqual(10);
  expect(deckSize).toBeLessThanOrEqual(15);
  // every deck card carries the hem line (moat inside first 2 minutes)
  await expect(page.getByTestId('swipe-card').getByTestId('hem-badge').first()).toBeVisible();
  await shot(page, 'deck');
  // like + pass both advance the deck
  await page.getByTestId('swipe-like').click();
  await page.waitForTimeout(340);
  await expect(page.getByText(new RegExp(`2 / ${deckSize}`))).toBeVisible();
  await page.getByTestId('swipe-pass').click();
  await page.waitForTimeout(340);
  await expect(page.getByText(new RegExp(`3 / ${deckSize}`))).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('swipe-like').click();
    await page.waitForTimeout(340);
  }
  // skippable after 5 swipes → building state → feed
  await page.getByTestId('deck-done').click();
  await expect(page).toHaveURL(/\/feed/, { timeout: 20_000 });
  await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 20_000 });
});

/* ═══ B2/B3 feed cards + filters ═════════════════════════════════════════ */

test('feed: every card complete (hem/source/freshness/price), filters URL-reflected, empty state graceful', async ({ page }) => {
  test.setTimeout(120_000);
  await onboard(page, 5, 4);
  const cards = page.getByTestId('product-card');
  const n = Math.min(await cards.count(), 12);
  expect(n).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const badge = (await card.getByTestId('hem-badge').textContent())!.trim();
    expect(badge, `card ${i} hem badge`).toMatch(/on you|Length unverified/);
    await expect(card.getByText(/Seen .* ago|Seen just now/), `card ${i} freshness`).toBeVisible();
    expect((await card.textContent())!, `card ${i} price`).toMatch(/[$£€]\s?\d/);
  }
  await shot(page, 'feed');

  // filters: size + length-on-you + source, all URL-reflected (B3)
  await page.getByTestId('open-filters').click();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '8', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'knee', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Brand sites' }).click();
  await shot(page, 'filter-sheet');
  await page.getByTestId('apply-filters').click();
  await expect(page).toHaveURL(/sizes=8/);
  await expect(page).toHaveURL(/len=knee/);
  await expect(page).toHaveURL(/src=brand/);

  // filtered results respect length-on-you
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  const filteredBadge = (await cards.first().getByTestId('hem-badge').textContent())!;
  expect(filteredBadge).toMatch(/knee/i);

  // URL state is shareable: reload keeps the filters active
  await page.reload();
  await expect(page.getByTestId('open-filters')).toHaveAttribute('aria-label', /3 active/);

  // graceful empty state
  await page.goto('/feed?q=zzzz-no-such-dress-zzzz');
  await expect(page.getByText('Nothing matches — yet')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'feed-empty');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
});

/* ═══ D1/D2 color analysis: quiz fallback → palette → NEVER hides ═════════ */

test('color: quiz fallback → season → chips removable → palette never hides dresses', async ({ page }) => {
  test.setTimeout(150_000);
  await onboard(page, 5, 4);

  // capture the pre-palette result set (real mode) — paginate to exhaustion
  // so boost-driven reordering across page boundaries can't false-positive
  const rankAll = async () => {
    const ids: string[] = [];
    let total = 0;
    let cursor: string | undefined;
    do {
      const res = await page.request.post('/api/rank', {
        data: { userId: 'cookie', filters: {}, limit: 100, cursor, personalize: true },
      });
      expect(res.ok()).toBeTruthy();
      const { data } = await res.json();
      total = data.totalMatched as number;
      ids.push(...(data.items as { listing: { id: string } }[]).map((i) => i.listing.id));
      cursor = data.nextCursor ?? undefined;
    } while (cursor);
    return { total, ids: ids.sort() };
  };
  const before = isMock() ? null : await rankAll();

  // quiz fallback path (D1: never mandatory, works keyless)
  await page.goto('/color-analysis');
  await expect(page.getByText('analyzed, then deleted', { exact: false })).toBeVisible();
  await page.getByTestId('quiz-fallback').click();
  await page.getByRole('button', { name: 'Green or olive' }).click();
  await page.getByRole('button', { name: 'Gold', exact: true }).click();
  await page.getByRole('button', { name: /Soft cream/ }).click();
  await page.getByRole('button', { name: 'Almost never burns' }).click();
  await page.getByRole('button', { name: 'Dark brown', exact: true }).click();
  await page.getByRole('button', { name: 'Brown', exact: true }).click();
  await expect(page.getByTestId('season-name')).toContainText('Autumn', { timeout: 15_000 });
  await page.getByTestId('confirm-season').click();
  await expect(page.getByText('Saved to your profile')).toBeVisible();
  await shot(page, 'season-card');
  await page.getByTestId('palette-to-feed').click();
  await expect(page).toHaveURL(/\/feed/);

  // D2: global boost chip visible + removable
  await expect(page.getByText('boosting your palette')).toBeVisible();
  await shot(page, 'feed-palette');
  await page.getByRole('button', { name: 'Turn off palette boost' }).click();
  await expect(page.getByText('boosting your palette')).toHaveCount(0);

  // HARD REQUIREMENT: palette must never hide dresses — identical result set
  if (before) {
    const after = await rankAll();
    expect(after.total, 'palette must not change totalMatched').toBe(before.total);
    expect(after.ids, 'palette must not change the result SET (order may differ)').toEqual(before.ids);
  }
});

/* ═══ F1 rack: save → unsave → possibly-sold ═════════════════════════════ */

test('rack: save appears, unsave disappears, stale saves flagged possibly-sold', async ({ page }) => {
  test.setTimeout(120_000);
  await onboard(page, 5, 4);
  const firstCard = page.getByTestId('product-card').first();
  const title = (await firstCard.locator('p').first().textContent())!.trim();
  await firstCard.getByRole('button', { name: 'Save to rack' }).click();

  await page.goto('/saved');
  await expect(page.getByTestId('product-card').filter({ hasText: title })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'rack-saved');

  // unsave → gone
  await page
    .getByTestId('product-card')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Remove from rack' })
    .click();
  await expect(page.getByTestId('product-card').filter({ hasText: title })).toHaveCount(0);

  // possibly-sold flag on a stale save (real mode: seeded 71.6h-old fixture)
  if (!isMock()) {
    const staleId = 'fixture:ebay:v1|256522887998|0';
    const res = await page.request.post('/api/saves', { data: { listingId: staleId } });
    expect(res.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByText(/Possibly sold — last seen/)).toBeVisible({ timeout: 15_000 });
    await shot(page, 'rack-possibly-sold');
  }
});

/* ═══ A3 profile edit → hem regression check ═════════════════════════════ */

test('profile: editing height re-computes hem badges (regression-critical)', async ({ page }) => {
  test.setTimeout(120_000);
  await onboard(page, 4, 11);
  const firstCard = page.getByTestId('product-card').first();
  const href = (await firstCard.getByRole('link').first().getAttribute('href'))!;
  await page.goto(href);
  await expect(page.getByTestId('hem-module')).toBeVisible();
  const petiteLine = (await page.getByTestId('hem-detail-line').textContent())!.trim();

  // edit height 4'11" → 6'0" in settings
  await page.goto('/profile');
  await page.getByLabel('Feet').selectOption('6');
  await page.getByLabel('Inches').selectOption('0');
  await page.waitForTimeout(600); // PATCH autosave

  await page.goto(href);
  await expect(page.getByTestId('hem-module')).toBeVisible();
  const tallLine = (await page.getByTestId('hem-detail-line').textContent())!.trim();
  expect(tallLine).not.toBe(petiteLine);
});

/* ═══ C1/C3 detail: measurements, vintage caution, link-out ══════════════ */

test('detail: measurements table, vintage caution, affiliate/source link-out (real fixtures)', async ({ page }) => {
  test.skip(isMock(), 'fixture ids are a real-mode seed contract');
  await onboard(page, 5, 4);

  // listing with parseable measurements → table renders (C3)
  const measuredId = encodeURIComponent('fixture:ebay:v1|269145167879|0');
  await page.goto(`/dress/${measuredId}`);
  await expect(page.getByTestId('hem-module')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Bust' })).toBeVisible();
  await expect(page.getByText('Garment measured flat', { exact: false })).toBeVisible();
  await shot(page, 'detail-measurements');

  // vintage listing without measurements → standing caution (C3)
  const vintageId = encodeURIComponent('fixture:ebay:v1|242483324445|0');
  await page.goto(`/dress/${vintageId}`);
  await expect(page.getByText(/Vintage sizing often runs 3–4 sizes small/)).toBeVisible();
  await shot(page, 'detail-vintage');

  // C1: outbound CTA href matches the API's affiliate-or-source url, new tab
  const res = await page.request.get(`/api/listings/${measuredId}`);
  const { data } = await res.json();
  const expectedUrl = data.listing.affiliateUrl ?? data.listing.sourceUrl;
  await page.goto(`/dress/${measuredId}`);
  const cta = page.getByTestId('shop-cta');
  await expect(cta).toHaveAttribute('href', expectedUrl);
  await expect(cta).toHaveAttribute('target', '_blank');
  await expect(cta).toHaveAttribute('rel', /noopener/);
});

/* ═══ mobile narrow viewport sanity ══════════════════════════════════════ */

test('320px narrow viewport: landing + feed do not overflow horizontally', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await ctx.newPage();
  await page.goto('/');
  const overflowLanding = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowLanding, 'landing horizontal overflow px').toBeLessThanOrEqual(1);
  await onboard(page, 5, 4);
  const overflowFeed = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowFeed, 'feed horizontal overflow px').toBeLessThanOrEqual(1);
  await shot(page, 'narrow-320-feed');
  await ctx.close();
});
