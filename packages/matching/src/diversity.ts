/**
 * Brand/source diversity guard for ranked pages (2026-07-09, matching-eng).
 *
 * Why: the §6 candidate pool is capped at 500. After a big sequential crawl,
 * "newest 500" collapses to "the last store crawled", and the feed/deck render
 * a monoculture. The pool fix is stratified capping (filters.ts stratifiedCap
 * shared with packages/db queryCandidates); THIS module is the second line of
 * defense: a light MMR-style interleave over the already-scored order so no
 * brand — and no single store hiding behind noisy brand labels — dominates a
 * page even when scores are near-identical.
 *
 * Thresholds (docs/decisions-matching.md):
 * - MAX_ADJACENT_SAME_BRAND 2 — never 3 same-brand cards in a row.
 * - MAX_PER_BRAND_PER_WINDOW 6 per 24 — a default page shows ≥4 brands
 *   whenever the pool has them (24 / 6 = 4).
 * - MAX_PER_SOURCE_PER_WINDOW 12 per 24 — no store takes more than half a
 *   page, even when its "brands" are really collection labels.
 *
 * Design constraints:
 * - STABLE re-shuffle: relative order within a brand is never changed; an item
 *   is only deferred, never promoted past a same-brand item. Personalized
 *   scores still dominate.
 * - Pure re-ordering: the result SET is identical — never a filter.
 * - Degrades to a no-op when the pool is (or a filter makes it) single-brand.
 */
import type { Listing } from '@hemline/contracts';

/** No more than 2 consecutive cards from the same brand. */
export const MAX_ADJACENT_SAME_BRAND = 2;
/** Sliding window ≈ one feed page. */
export const BRAND_WINDOW_SIZE = 24;
/**
 * Max cards per brand within any BRAND_WINDOW_SIZE-long stretch. 24/6 = 4 ⇒ a
 * default 24-item page shows ≥4 distinct brands whenever the pool has them.
 */
export const MAX_PER_BRAND_PER_WINDOW = 6;
/** Max cards per SOURCE per window — half a page, robust to brand-label noise. */
export const MAX_PER_SOURCE_PER_WINDOW = 12;

export interface InterleaveOptions<T> {
  /** max run of consecutive same-key items (default MAX_ADJACENT_SAME_BRAND) */
  maxAdjacent?: number;
  /** sliding window length (default BRAND_WINDOW_SIZE) */
  windowSize?: number;
  /** max same-key items within any window (default MAX_PER_BRAND_PER_WINDOW) */
  maxPerWindow?: number;
  /** optional second diversity axis: the item's source/store */
  sourceKeyOf?: (item: T) => string;
  /** max same-source items within any window (default MAX_PER_SOURCE_PER_WINDOW) */
  maxPerSourceWindow?: number;
}

/**
 * Diversity key for a listing: normalized brand, falling back to the source id
 * so brandless listings from one store still count as one "brand". Resilient
 * to brand-name noise — junk brands just become extra small strata (and the
 * source axis catches a store hiding behind many labels).
 */
export function brandKeyOf(listing: Pick<Listing, 'brand' | 'sourceId'>): string {
  const brand = listing.brand?.trim().toLowerCase();
  return brand ? brand : `source:${listing.sourceId}`;
}

/**
 * Greedy stable interleave. Walks the scored order; when the next item would
 * create a same-brand run longer than `maxAdjacent`, push a brand over
 * `maxPerWindow`, or push a source over `maxPerSourceWindow` within the
 * sliding window, the earliest item that satisfies the constraints is pulled
 * forward instead (deferred items keep their relative order). Constraint
 * relaxation order when nothing qualifies: source cap first, then the brand
 * window cap, then adjacency — so a single-brand pool passes through
 * unchanged and a page is never starved.
 */
export function interleaveByBrand<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  opts: InterleaveOptions<T> = {},
): T[] {
  const maxAdjacent = opts.maxAdjacent ?? MAX_ADJACENT_SAME_BRAND;
  const windowSize = opts.windowSize ?? BRAND_WINDOW_SIZE;
  const maxPerWindow = opts.maxPerWindow ?? MAX_PER_BRAND_PER_WINDOW;
  const maxPerSourceWindow = opts.maxPerSourceWindow ?? MAX_PER_SOURCE_PER_WINDOW;
  const sourceKeyOf = opts.sourceKeyOf;
  if (items.length <= 1) return [...items];

  const pending = [...items];
  const out: T[] = [];
  const outBrands: string[] = [];
  const outSources: string[] = [];

  const trailingRun = (key: string): number => {
    let run = 0;
    for (let i = outBrands.length - 1; i >= 0 && outBrands[i] === key; i--) run++;
    return run;
  };
  const windowCount = (keys: string[], key: string): number => {
    let count = 0;
    const start = Math.max(0, keys.length - (windowSize - 1));
    for (let i = start; i < keys.length; i++) if (keys[i] === key) count++;
    return count;
  };

  const brandOk = (it: T) => {
    const k = keyOf(it);
    return trailingRun(k) < maxAdjacent && windowCount(outBrands, k) < maxPerWindow;
  };
  const sourceOk = (it: T) =>
    !sourceKeyOf || windowCount(outSources, sourceKeyOf(it)) < maxPerSourceWindow;

  while (pending.length > 0) {
    // preferred: satisfies adjacency + brand window + source window
    let idx = pending.findIndex((it) => brandOk(it) && sourceOk(it));
    // relax the source cap (pool too shallow on sources)
    if (idx === -1) idx = pending.findIndex(brandOk);
    // relax the brand window cap too, keep adjacency
    if (idx === -1) idx = pending.findIndex((it) => trailingRun(keyOf(it)) < maxAdjacent);
    // single brand left — pass through
    if (idx === -1) idx = 0;

    const [item] = pending.splice(idx, 1);
    out.push(item);
    outBrands.push(keyOf(item));
    outSources.push(sourceKeyOf ? sourceKeyOf(item) : '');
  }
  return out;
}
