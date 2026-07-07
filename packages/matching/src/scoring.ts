/**
 * Deterministic scoring — docs/ARCHITECTURE.md §6.
 *
 *   score₀ = attributeSimilarity × paletteBoost (1.0–1.25) × freshnessDecay
 *   freshnessDecay = exp(−ln2 · ageDays / halfLifeDays); halfLife 7d resale, 21d DTC
 *   blend  = 0.6 · llmRank + 0.4 · score₀
 *
 * Pure functions only.
 */
import type { ColorTag, PaletteColor } from '@hemline/contracts';

export const RESALE_HALF_LIFE_DAYS = 7;
export const DTC_HALF_LIFE_DAYS = 21;
export const PALETTE_BOOST_MAX = 1.25;
export const LLM_BLEND_WEIGHT = 0.6;

/** exp(−ln2 · ageDays / halfLifeDays); 0..1, =0.5 at exactly one half-life. */
export function freshnessDecay(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  const age = Math.max(0, ageDays);
  return Math.exp((-Math.LN2 * age) / halfLifeDays);
}

/** Resale sources churn fast (7d half-life); DTC restocks slowly (21d). */
export function halfLifeDaysForSource(sourceId: string): number {
  return /(^|:)ebay\b|poshmark|depop|resale/i.test(sourceId)
    ? RESALE_HALF_LIFE_DAYS
    : DTC_HALF_LIFE_DAYS;
}

/**
 * Soft palette boost 1.0–1.25 (doc §6). Never a filter — a listing with zero
 * palette overlap keeps boost 1.0. Match = same color family as a palette
 * entry's family guess, or hex within a small RGB distance.
 */
export function paletteBoost(palette: PaletteColor[], colors: ColorTag[]): number {
  if (palette.length === 0 || colors.length === 0) return 1;
  let matched = 0;
  for (const color of colors) {
    if (paletteMatchesColor(palette, color)) matched++;
  }
  const fraction = matched / colors.length;
  return 1 + (PALETTE_BOOST_MAX - 1) * fraction;
}

/** True when a listing color matches any palette color (used for the UI chip). */
export function paletteMatchesColor(palette: PaletteColor[], color: ColorTag): boolean {
  for (const p of palette) {
    if (color.name && p.name && normalizeName(color.name) === normalizeName(p.name)) {
      return true;
    }
    if (color.hex && p.hex && hexDistance(color.hex, p.hex) <= 80) return true;
  }
  return false;
}

/** blend = 0.6·llmRank + 0.4·score₀ (both 0..1). */
export function blendScores(llmRank: number, score0: number): number {
  return LLM_BLEND_WEIGHT * llmRank + (1 - LLM_BLEND_WEIGHT) * score0;
}

export interface Score0Input {
  /** 0..1 (see attributeSimilarity) */
  similarity: number;
  /** 1.0–1.25 */
  paletteBoost: number;
  /** 0..1 */
  freshnessDecay: number;
}

/** score₀ = similarity × paletteBoost × freshnessDecay, clamped to 0..1. */
export function score0({ similarity, paletteBoost, freshnessDecay }: Score0Input): number {
  return Math.max(0, Math.min(1, similarity * paletteBoost * freshnessDecay));
}

/**
 * Map an LLM ranking position (0 = best) over n candidates to a 0..1 score for
 * blending. Single candidate → 1.
 */
export function rankPositionToScore(position: number, n: number): number {
  if (n <= 1) return 1;
  return 1 - position / (n - 1);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Euclidean distance in RGB space (0..~441). */
export function hexDistance(a: string, b: string): number {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return Number.POSITIVE_INFINITY;
  return Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2);
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
