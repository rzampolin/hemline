/**
 * Dense-embedding similarity math (Marqo-FashionSigLIP upgrade path,
 * docs/ARCHITECTURE.md §1 vector row) — pure functions, no I/O.
 *
 * This is the embedding-backed variant of the StyleSimilarity seam. Embedding
 * scores never replace the attribute-vector path — they BLEND with it when a
 * vector exists and fall back to it when not (see blendSimilarity), so the app
 * degrades exactly like the keyless-AI story when ml/ isn't set up.
 */
import { EMBEDDING_MODEL_TAG, type StyleSimilarity } from '@hemline/contracts';
import { SWIPE_LEARNING_RATE, SWIPE_VERDICT_WEIGHT } from './similarity';

export { EMBEDDING_MODEL_TAG };

/**
 * Weight of the embedding score when blending with the attribute score —
 * deliberately the same 0.6/0.4 split the §6 pipeline uses for llmRank vs
 * score₀ (LLM_BLEND_WEIGHT): the richer signal leads, the cheap one anchors.
 */
export const EMBEDDING_BLEND_WEIGHT = 0.6;

/** Cosine similarity of two dense vectors (−1..1). 0 when either is zero/mismatched. */
export function cosineDense(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine mapped into 0..1 for scoring (same convention as
 * attributeSimilarity): (cos + 1) / 2; neutral 0.5 for zero/empty vectors.
 */
export function embeddingSimilarity(a: Float32Array | null, b: Float32Array | null): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0.5;
  return (cosineDense(a, b) + 1) / 2;
}

/**
 * Compose the two similarity signals (both 0..1):
 * embedding present → 0.6·embedding + 0.4·attribute; absent → attribute alone.
 */
export function blendSimilarity(attributeScore: number, embeddingScore: number | null): number {
  if (embeddingScore == null) return attributeScore;
  return EMBEDDING_BLEND_WEIGHT * embeddingScore + (1 - EMBEDDING_BLEND_WEIGHT) * attributeScore;
}

/** L2-normalize in place-safe copy. Zero vector stays zero. */
export function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export interface WeightedVector {
  vector: Float32Array;
  weight?: number;
}

/** Weighted mean of vectors, L2-normalized. Null when nothing usable. */
export function averageEmbeddings(inputs: WeightedVector[]): Float32Array | null {
  const usable = inputs.filter((v) => v.vector.length > 0 && (v.weight ?? 1) > 0);
  if (usable.length === 0) return null;
  const dim = usable[0].vector.length;
  const acc = new Float32Array(dim);
  let total = 0;
  for (const { vector, weight = 1 } of usable) {
    if (vector.length !== dim) continue;
    for (let i = 0; i < dim; i++) acc[i] += weight * vector[i];
    total += weight;
  }
  if (total === 0) return null;
  for (let i = 0; i < dim; i++) acc[i] /= total;
  const normalized = l2Normalize(acc);
  let nonZero = false;
  for (let i = 0; i < dim; i++) {
    if (normalized[i] !== 0) {
      nonZero = true;
      break;
    }
  }
  return nonZero ? normalized : null;
}

export interface EmbeddedSwipe {
  verdict: 'like' | 'dislike' | 'save' | 'skip';
  vector: Float32Array;
}

/**
 * Style-profile embedding from swipes: the weighted average of LIKED/SAVED
 * item embeddings (save counts 1.25× a like, mirroring SWIPE_VERDICT_WEIGHT).
 * Dislikes/skips are deliberately ignored — subtracting vectors from a mean
 * on the unit sphere is noisy at calibration sample sizes; keep it simple and
 * let the attribute path (which does learn negatives) carry dislike signal.
 */
export function styleEmbeddingFromSwipes(swipes: EmbeddedSwipe[]): Float32Array | null {
  return averageEmbeddings(
    swipes
      .filter((s) => s.verdict === 'like' || s.verdict === 'save')
      .map((s) => ({ vector: s.vector, weight: SWIPE_VERDICT_WEIGHT[s.verdict] })),
  );
}

// ── StyleSimilarity adapter (contract boundary is Record<string, number>) ──

/** Dense Float32Array → the sparse {"0": v0, …} form the contract carries. */
export function denseToSparse(v: Float32Array): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < v.length; i++) out[String(i)] = v[i];
  return out;
}

/** Sparse-serialized dense vector back to Float32Array (missing keys → 0). */
export function sparseToDense(rec: Record<string, number>, dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (const [k, val] of Object.entries(rec)) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < dim) out[i] = val;
  }
  return out;
}

/**
 * The embedding-backed StyleSimilarity — exactly the adapter sketched in
 * similarity.ts's upgrade-path comment. Vectors cross the contract boundary
 * sparse-serialized ({"0": …}); scoring is dense cosine; swipe learning is
 * the same EMA rule as attribute-v1, on the unit sphere (positive verdicts
 * pull toward the item, dislikes push away, then renormalize).
 */
export function createEmbeddingStyleSimilarity(dim: number): StyleSimilarity {
  return {
    kind: 'fashion-siglip-v1',
    score(userStyleTags, listingVector) {
      return embeddingSimilarity(
        sparseToDense(userStyleTags, dim),
        sparseToDense(listingVector, dim),
      );
    },
    updateFromSwipes(current, events) {
      let acc = sparseToDense(current, dim);
      for (const ev of events) {
        const w = SWIPE_VERDICT_WEIGHT[ev.verdict];
        if (!w) continue;
        const item = sparseToDense(ev.attributeVector, dim);
        for (let i = 0; i < dim; i++) acc[i] += SWIPE_LEARNING_RATE * w * item[i];
      }
      acc = l2Normalize(acc);
      return denseToSparse(acc);
    },
  };
}
