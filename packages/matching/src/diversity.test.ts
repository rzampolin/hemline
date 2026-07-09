import { describe, expect, it } from 'vitest';
import {
  BRAND_WINDOW_SIZE,
  MAX_ADJACENT_SAME_BRAND,
  MAX_PER_BRAND_PER_WINDOW,
  MAX_PER_SOURCE_PER_WINDOW,
  brandKeyOf,
  interleaveByBrand,
} from './diversity';

/** item i of brand k, in descending-score order by construction */
interface Item {
  id: string;
  brand: string;
}

function pool(counts: Record<string, number>): Item[] {
  // brand A's items all outscore B's, which outscore C's, … (worst case for
  // diversity: the exact shape a monoculture candidate pool produces)
  const items: Item[] = [];
  for (const [brand, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) items.push({ id: `${brand}${i}`, brand });
  }
  return items;
}

const keyOf = (it: Item) => it.brand;

function maxRun(items: Item[]): number {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const it of items) {
    run = it.brand === prev ? run + 1 : 1;
    prev = it.brand;
    best = Math.max(best, run);
  }
  return best;
}

describe('interleaveByBrand — gate scenario (400 A + 30 each B/C/D)', () => {
  const items = pool({ A: 400, B: 30, C: 30, D: 30 });
  const out = interleaveByBrand(items, keyOf);

  it('top-24 page contains ≥4 distinct brands', () => {
    const page = out.slice(0, 24);
    expect(new Set(page.map((i) => i.brand)).size).toBeGreaterThanOrEqual(4);
  });

  it('no 3-in-a-row while other brands remain (tail may be all-A once B/C/D exhaust)', () => {
    const brands = out.map((i) => i.brand);
    const lastNonA = brands.length - 1 - [...brands].reverse().findIndex((b) => b !== 'A');
    expect(lastNonA).toBeGreaterThan(24); // sanity: interleaved region is real
    expect(maxRun(out.slice(0, lastNonA + 1))).toBeLessThanOrEqual(MAX_ADJACENT_SAME_BRAND);
  });

  it('the dominant brand cannot flood the first page past the density cap (+1 relaxation slack)', () => {
    const page = out.slice(0, BRAND_WINDOW_SIZE);
    const aCount = page.filter((i) => i.brand === 'A').length;
    // the sliding-window cap is 6; the deliberate relaxation (never starve a
    // page when every brand is capped) can admit at most one extra
    expect(aCount).toBeLessThanOrEqual(MAX_PER_BRAND_PER_WINDOW + 1);
  });

  it('is a pure re-ordering: same multiset, within-brand order preserved (stable)', () => {
    expect(out).toHaveLength(items.length);
    expect(new Set(out.map((i) => i.id)).size).toBe(items.length);
    for (const brand of ['A', 'B', 'C', 'D']) {
      const seq = out.filter((i) => i.brand === brand).map((i) => i.id);
      expect(seq).toEqual(items.filter((i) => i.brand === brand).map((i) => i.id));
    }
  });

  it('personalization still dominates: the top card is the top-scored item', () => {
    expect(out[0].id).toBe('A0');
  });
});

describe('interleaveByBrand — degradation', () => {
  it('single-brand pool passes through unchanged (explicit brand filter is a no-op)', () => {
    const items = pool({ A: 50 });
    expect(interleaveByBrand(items, keyOf)).toEqual(items);
  });

  it('two-brand pool: window cap relaxes rather than starving the page', () => {
    const items = pool({ A: 40, B: 40 });
    const out = interleaveByBrand(items, keyOf);
    expect(out).toHaveLength(80);
    // adjacency holds while both brands still have depth (first page and beyond)
    expect(maxRun(out.slice(0, 40))).toBeLessThanOrEqual(MAX_ADJACENT_SAME_BRAND);
    expect(new Set(out.slice(0, 24).map((i) => i.brand)).size).toBe(2);
  });

  it('empty and single-item inputs', () => {
    expect(interleaveByBrand([], keyOf)).toEqual([]);
    const one = pool({ A: 1 });
    expect(interleaveByBrand(one, keyOf)).toEqual(one);
  });

  it('a store hiding behind noisy brand labels is capped by the source axis', () => {
    // S1's "brands" are collection names (one per item) — the brand caps never
    // bind for it. S2/S3 are honest single-brand stores. Without the source
    // axis, S1 would fill whole pages.
    const items: Array<Item & { source: string }> = [];
    for (let i = 0; i < 48; i++) items.push({ id: `s1-${i}`, brand: `Collection ${i}`, source: 'S1' });
    for (let i = 0; i < 24; i++) items.push({ id: `s2-${i}`, brand: 'X', source: 'S2' });
    for (let i = 0; i < 24; i++) items.push({ id: `s3-${i}`, brand: 'Y', source: 'S3' });
    const out = interleaveByBrand(items, keyOf, { sourceKeyOf: (it) => it.source });
    const first24 = out.slice(0, 24);
    const s1Count = first24.filter((i) => i.source === 'S1').length;
    // 12 is the cap; the page-never-starves relaxation may admit a couple more
    expect(s1Count).toBeLessThanOrEqual(MAX_PER_SOURCE_PER_WINDOW + 2);
    expect(new Set(first24.map((i) => i.source)).size).toBe(3);
  });

  it('already-diverse input is barely touched', () => {
    const items = [
      { id: 'A0', brand: 'A' },
      { id: 'B0', brand: 'B' },
      { id: 'C0', brand: 'C' },
      { id: 'A1', brand: 'A' },
      { id: 'B1', brand: 'B' },
      { id: 'C1', brand: 'C' },
    ];
    expect(interleaveByBrand(items, keyOf)).toEqual(items);
  });
});

describe('brandKeyOf', () => {
  it('normalizes brand casing/whitespace', () => {
    expect(brandKeyOf({ brand: '  Sister Jane ', sourceId: 's' })).toBe('sister jane');
  });
  it('falls back to source id for brandless listings', () => {
    expect(brandKeyOf({ brand: null, sourceId: 'shopify:x.com' })).toBe('source:shopify:x.com');
    expect(brandKeyOf({ brand: '   ', sourceId: 'shopify:x.com' })).toBe('source:shopify:x.com');
  });
});
