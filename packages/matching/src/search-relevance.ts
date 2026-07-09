/**
 * Query-relevance math for hybrid free-text search (docs/decisions-search.md)
 * — pure functions, no I/O.
 *
 * A query search scores each candidate on up to three 0..1 components:
 *   attribute — soft taxonomy signals (occasion/color/fabric/…) vs the
 *               listing's sparse attribute vector          (weight .5)
 *   semantic  — query-text embedding vs the listing's FashionSigLIP vector,
 *               min-max normalized within the candidate set (weight .3)
 *   lexical   — residual query tokens vs title/brand/description (weight .2)
 * Weights renormalize over whichever components are AVAILABLE, so no
 * vectors / no soft signals / no residual text just redistributes weight —
 * semantic is an additive boost/recall path, never a gate.
 *
 * Evidence gate: a candidate stays in a query result only with at least one
 * positive signal (any attribute match, any lexical hit, or a top-K semantic
 * rank). Queries that consumed entirely into HARD filters ("STAUD mini")
 * carry no scoring signals — the gate and relevance are skipped and the
 * normal score₀ pipeline stands.
 */

/** Component weights (renormalized over available components). */
export const RELEVANCE_WEIGHTS = { attribute: 0.5, semantic: 0.3, lexical: 0.2 } as const;

/** Final search blend: relevance leads, score₀ (style/palette/freshness) anchors. */
export const SEARCH_BLEND_WEIGHT = 0.7;

/** Top-K semantic ranks that count as retrieval EVIDENCE (vocabulary-gap recall). */
export const SEMANTIC_RECALL_TOP_K = 50;

/** The soft signals a query interpreter produces (mirrors ai's ParsedQuerySoft). */
export interface SoftQuerySignals {
  occasions: string[];
  colorFamilies: string[];
  fabrics: string[];
  silhouettes: string[];
  necklines: string[];
  patterns: string[];
}

const SOFT_TAG_PREFIX: Array<[keyof SoftQuerySignals, string]> = [
  ['occasions', 'occasion'],
  ['colorFamilies', 'color'],
  ['fabrics', 'fabric'],
  ['silhouettes', 'silhouette'],
  ['necklines', 'neckline'],
  ['patterns', 'pattern'],
];

export function countSoftSignals(soft: SoftQuerySignals): number {
  return SOFT_TAG_PREFIX.reduce((n, [key]) => n + soft[key].length, 0);
}

/**
 * Fraction of soft query signals present in the listing's sparse attribute
 * vector (the same `occasion:formal` / `color:pink` / `fabric:silk` tags the
 * extractors build). Null when the query carries no soft signals.
 */
export function attributeMatchScore(
  soft: SoftQuerySignals,
  attributeVector: Record<string, number>,
): number | null {
  const total = countSoftSignals(soft);
  if (total === 0) return null;
  let matched = 0;
  for (const [key, prefix] of SOFT_TAG_PREFIX) {
    for (const value of soft[key]) {
      const tag = `${prefix}:${value.toLowerCase().split(/\s+/)[0]}`;
      if ((attributeVector[tag] ?? 0) > 0) matched++;
    }
  }
  return matched / total;
}

/**
 * Fraction of residual tokens found (substring, case-insensitive) in the
 * listing's text. Null when the query has no residual tokens.
 */
export function lexicalMatchScore(residualTokens: string[], haystack: string): number | null {
  if (residualTokens.length === 0) return null;
  const text = haystack.toLowerCase();
  let matched = 0;
  for (const token of residualTokens) {
    if (text.includes(token.toLowerCase())) matched++;
  }
  return matched / residualTokens.length;
}

/**
 * Min-max normalize raw semantic similarities within one candidate set so the
 * component compares fairly with the fraction-based ones (raw SigLIP
 * text↔image cosines cluster in a narrow band). Constant sets → all 0.5.
 */
export function normalizeSemanticScores(raw: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (raw.size === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  for (const [id, v] of raw) {
    out.set(id, span === 0 ? 0.5 : (v - min) / span);
  }
  return out;
}

/** Ids of the top-K raw semantic scores — the semantic EVIDENCE set. */
export function semanticTopK(raw: Map<string, number>, k = SEMANTIC_RECALL_TOP_K): Set<string> {
  return new Set(
    [...raw.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id]) => id),
  );
}

export interface RelevanceComponents {
  attribute: number | null;
  semantic: number | null;
  lexical: number | null;
}

/**
 * Blend the available components with renormalized weights. Null when NO
 * component is available (the caller should skip relevance entirely).
 */
export function blendRelevance(c: RelevanceComponents): number | null {
  let weightSum = 0;
  let acc = 0;
  if (c.attribute != null) {
    acc += RELEVANCE_WEIGHTS.attribute * c.attribute;
    weightSum += RELEVANCE_WEIGHTS.attribute;
  }
  if (c.semantic != null) {
    acc += RELEVANCE_WEIGHTS.semantic * c.semantic;
    weightSum += RELEVANCE_WEIGHTS.semantic;
  }
  if (c.lexical != null) {
    acc += RELEVANCE_WEIGHTS.lexical * c.lexical;
    weightSum += RELEVANCE_WEIGHTS.lexical;
  }
  if (weightSum === 0) return null;
  return acc / weightSum;
}

/** searchScore = 0.7·relevance + 0.3·score₀ (both 0..1). */
export function blendSearchScore(relevance: number, score0: number): number {
  return SEARCH_BLEND_WEIGHT * relevance + (1 - SEARCH_BLEND_WEIGHT) * score0;
}
