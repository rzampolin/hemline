/**
 * Swipe-deck sampling (PRODUCT_SPEC E1): the deck exists to harvest
 * calibration signal, so it must be diversity-sampled — a monoculture deck
 * teaches the taste vector nothing.
 *
 * 2026-07-09 (docs/decisions-matching.md): the sampler now stratifies
 * explicitly across SOURCES and BRANDS (round-robin over sources, and over
 * each source's brand queues — so a store whose "brands" are collection
 * labels can't flood the deck), preferring an unseen silhouette, then an
 * unseen length|silhouette|color combo, within each brand's turn. Ranked
 * order is preserved inside every brand queue. A 12-card deck therefore shows
 * min(#brands, 12) distinct brands even when the upstream pool is skewed by
 * one store's crawl.
 */
import type { RankedListing, SwipeEvent } from '@hemline/contracts';

export const DECK_SIZE = 12;

// ── adaptive calibration (2026-07-10, docs/decisions-deck.md) ─────────────
// Completion is driven by POSITIVE signal, not card count: 2 likes is not a
// style. Proceed at ≥5 likes/saves, extend in small batches otherwise, and
// never trap the user past ~30 cards.

/** Likes+saves needed before the deck considers the style vector fed. */
export const DECK_LIKE_TARGET = 5;
/** Hard cap on cards shown — past this we proceed gracefully regardless. */
export const DECK_CARD_CAP = 30;
/** Adaptive extension batch size (trimmed so the cap is never overshot). */
export const DECK_EXTENSION_SIZE = 7;
/** Spare candidates fetched alongside the deck for seamless dead-card swaps. */
export const DECK_SPARES = 4;
/** How many dislikes on one attribute value (with zero likes) exclude it. */
export const DECK_EXCLUDE_DISLIKES = 2;

/** Brand key: normalized brand, falling back to source so brandless items group per store. */
function brandKey(item: RankedListing): string {
  const brand = item.listing.brand?.trim().toLowerCase();
  return brand ? brand : `source:${item.listing.sourceId}`;
}

function silhouetteKey(item: RankedListing): string {
  return item.listing.silhouette ?? 'unknown';
}

function comboKey(item: RankedListing): string {
  const l = item.listing;
  return `${l.lengthClass}|${l.silhouette}|${l.colors[0]?.family}`;
}

/** Rotating cursor over a source's brand queues. */
interface SourceQueues {
  brandQueues: RankedListing[][];
  cursor: number;
}

/** Attribute values to keep out of an extension batch (soft — see options). */
export interface DeckExclusions {
  silhouettes: ReadonlySet<string>;
  colorFamilies: ReadonlySet<string>;
}

/**
 * Additive sampling options (2026-07-10 adaptive calibration):
 * - `exclude`: silhouettes/color families the user has heavily disliked.
 *   SOFT — if the filtered pool can't fill the batch, excluded items are used
 *   to top up (a thin catalog must not starve the deck).
 * - `explored`: silhouettes/combos already shown in earlier batches. Seeding
 *   the sampler's "seen" sets with them biases picks toward UNexplored
 *   silhouettes/colors without hard-filtering anything.
 */
export interface DeckSampleOptions {
  exclude?: Partial<DeckExclusions>;
  explored?: { silhouettes?: Iterable<string>; combos?: Iterable<string> };
}

function isExcluded(item: RankedListing, exclude: Partial<DeckExclusions>): boolean {
  const sil = item.listing.silhouette;
  if (sil && exclude.silhouettes?.has(sil)) return true;
  const family = item.listing.colors[0]?.family;
  if (family && exclude.colorFamilies?.has(family)) return true;
  return false;
}

/**
 * Diversity-sample `n` cards across source, brand, silhouette, length and
 * color. Two-level round-robin (sources → each source's brands, both in
 * first-appearance = rank order); within a brand's turn, prefer an unseen
 * silhouette, then an unseen length|silhouette|color combo, then the brand's
 * best remaining card. See DeckSampleOptions for the additive adaptive knobs.
 */
export function sampleDeck(
  items: RankedListing[],
  n: number,
  options: DeckSampleOptions = {},
): RankedListing[] {
  const seenSilhouettes = new Set<string>(options.explored?.silhouettes ?? []);
  const seenCombos = new Set<string>(options.explored?.combos ?? []);
  const picked: RankedListing[] = [];

  const exclude = options.exclude;
  const preferred = exclude ? items.filter((it) => !isExcluded(it, exclude)) : items;
  sampleInto(picked, preferred, n, seenSilhouettes, seenCombos);
  if (picked.length < n && preferred.length < items.length) {
    // soft exclusion: top up from the excluded remainder rather than starve
    sampleInto(
      picked,
      items.filter((it) => isExcluded(it, exclude ?? {})),
      n,
      seenSilhouettes,
      seenCombos,
    );
  }
  return picked;
}

function sampleInto(
  picked: RankedListing[],
  items: RankedListing[],
  n: number,
  seenSilhouettes: Set<string>,
  seenCombos: Set<string>,
): void {
  // source → brand → ranked queue (insertion order = rank order throughout)
  const bySource = new Map<string, Map<string, RankedListing[]>>();
  for (const item of items) {
    let brands = bySource.get(item.listing.sourceId);
    if (!brands) {
      brands = new Map();
      bySource.set(item.listing.sourceId, brands);
    }
    const key = brandKey(item);
    const q = brands.get(key);
    if (q) q.push(item);
    else brands.set(key, [item]);
  }
  const sources: SourceQueues[] = [...bySource.values()].map((brands) => ({
    brandQueues: [...brands.values()],
    cursor: 0,
  }));

  const pickFrom = (q: RankedListing[]): RankedListing => {
    let idx = q.findIndex((it) => !seenSilhouettes.has(silhouetteKey(it)));
    if (idx === -1) idx = q.findIndex((it) => !seenCombos.has(comboKey(it)));
    if (idx === -1) idx = 0;
    const [item] = q.splice(idx, 1);
    seenSilhouettes.add(silhouetteKey(item));
    seenCombos.add(comboKey(item));
    return item;
  };

  while (picked.length < n) {
    let progressed = false;
    for (const source of sources) {
      if (picked.length >= n) break;
      // this source's turn: next non-empty brand queue in rotation
      for (let step = 0; step < source.brandQueues.length; step++) {
        const q = source.brandQueues[source.cursor % source.brandQueues.length];
        source.cursor++;
        if (q.length === 0) continue;
        picked.push(pickFrom(q));
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
}

// ── adaptive-completion helpers (pure, unit-tested) ───────────────────────

/** Likes + saves — the positive signal the deck exists to harvest. */
export function positiveCount(events: Pick<SwipeEvent, 'verdict'>[]): number {
  return events.filter((e) => e.verdict === 'like' || e.verdict === 'save').length;
}

/**
 * Why the deck should complete now, or null to keep going:
 * - 'target': enough positive signal (≥DECK_LIKE_TARGET likes/saves)
 * - 'cap': DECK_CARD_CAP cards seen — never trap the user
 */
export function deckCompletionReason(
  positives: number,
  cardsSeen: number,
): 'target' | 'cap' | null {
  if (positives >= DECK_LIKE_TARGET) return 'target';
  if (cardsSeen >= DECK_CARD_CAP) return 'cap';
  return null;
}

/** Extension batch size: 6–8 cards, trimmed so we never overshoot the cap. */
export function nextBatchSize(cardsSeen: number): number {
  return Math.max(0, Math.min(DECK_EXTENSION_SIZE, DECK_CARD_CAP - cardsSeen));
}

/**
 * Attribute values the user has heavily disliked: ≥DECK_EXCLUDE_DISLIKES
 * dislikes AND zero likes/saves on that silhouette / primary color family.
 * (A value she both liked and disliked is ambiguous — never excluded.)
 */
export function deriveExclusions(
  events: Pick<SwipeEvent, 'listingId' | 'verdict'>[],
  byId: ReadonlyMap<string, RankedListing>,
): DeckExclusions {
  const tally = new Map<string, { down: number; up: number }>();
  const bump = (key: string, positive: boolean) => {
    const t = tally.get(key) ?? { down: 0, up: 0 };
    if (positive) t.up++;
    else t.down++;
    tally.set(key, t);
  };
  for (const e of events) {
    const listing = byId.get(e.listingId)?.listing;
    if (!listing) continue;
    const positive = e.verdict === 'like' || e.verdict === 'save';
    if (listing.silhouette) bump(`sil:${listing.silhouette}`, positive);
    const family = listing.colors[0]?.family;
    if (family) bump(`col:${family}`, positive);
  }
  const silhouettes = new Set<string>();
  const colorFamilies = new Set<string>();
  for (const [key, t] of tally) {
    if (t.down < DECK_EXCLUDE_DISLIKES || t.up > 0) continue;
    if (key.startsWith('sil:')) silhouettes.add(key.slice(4));
    else colorFamilies.add(key.slice(4));
  }
  return { silhouettes, colorFamilies };
}

/** Silhouettes/combos already shown — feeds DeckSampleOptions.explored. */
export function exploredAttributes(shown: RankedListing[]): {
  silhouettes: Set<string>;
  combos: Set<string>;
} {
  return {
    silhouettes: new Set(shown.map(silhouetteKey)),
    combos: new Set(shown.map(comboKey)),
  };
}
