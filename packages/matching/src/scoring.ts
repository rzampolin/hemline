/**
 * Deterministic scoring — docs/ARCHITECTURE.md §6.
 * score₀ = attributeSimilarity × paletteBoost (1.0–1.25) × freshnessDecay
 * freshnessDecay = exp(−ln2 · ageDays / halfLifeDays); halfLife 7d resale, 21d DTC
 * blend = 0.6·llmRank + 0.4·score₀
 */
import type { ColorTag, PaletteColor } from '@hemline/contracts';

export function freshnessDecay(_ageDays: number, _halfLifeDays: number): number {
  throw new Error('not yet implemented (ai-eng): freshness decay — docs/ARCHITECTURE.md §6');
}

export function paletteBoost(_palette: PaletteColor[], _colors: ColorTag[]): number {
  throw new Error('not yet implemented (ai-eng): palette boost 1.0–1.25 — §6');
}

export function blendScores(_llmRank: number, _score0: number): number {
  throw new Error('not yet implemented (ai-eng): 0.6·llm + 0.4·deterministic blend — §6');
}
