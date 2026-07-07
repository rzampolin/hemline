/**
 * Style similarity — docs/ARCHITECTURE.md §6 + §1 (vector row).
 *
 * v1: Claude-extracted sparse attribute vectors, cosine in TS. No embedding
 * model, no I/O — pure functions. The `StyleSimilarity` interface is the seam
 * for the documented upgrade path (Marqo-FashionSigLIP embeddings + sqlite-vec)
 * so the swap never touches callers.
 */
import type { SwipeEvent } from '@hemline/contracts';

/**
 * The pluggable similarity backend (doc §1 "behind the StyleSimilarity
 * interface"). v1 ships `attributeStyleSimilarity`; a future
 * FashionSigLIP adapter implements the same interface:
 *
 *   // Upgrade path (deferred, doc §10): a sidecar service embeds listing
 *   // images with Marqo-FashionSigLIP; vectors live in sqlite-vec. The
 *   // adapter would look like:
 *   //
 *   //   export const fashionSigLipSimilarity: StyleSimilarity = {
 *   //     kind: 'fashion-siglip-v1',
 *   //     score: (userVec, listingVec) => cosineDense(userVec, listingVec),
 *   //     updateFromSwipes: (current, events) =>
 *   //       emaUpdate(current, events), // events carry dense 768-d vectors
 *   //   };
 *   //
 *   // Because both the user style vector and the listing vector are opaque
 *   // Record<string, number> maps at the contract boundary, dense vectors
 *   // serialize as {"0": .., "1": ..} with zero contract changes.
 */
export interface StyleSimilarity {
  /** Implementation tag, persisted alongside vectors for future migrations. */
  readonly kind: string;
  /** Similarity of a user style vector vs a listing vector, mapped to 0..1. */
  score(
    userStyleTags: Record<string, number>,
    listingAttributeVector: Record<string, number>,
  ): number;
  /** Fold swipe like/dislike events into the user's profile style vector. */
  updateFromSwipes(
    current: Record<string, number>,
    events: SwipeSignal[],
  ): Record<string, number>;
}

export interface SwipeSignal {
  verdict: SwipeEvent['verdict'];
  /** The swiped listing's sparse attribute vector. */
  attributeVector: Record<string, number>;
}

/** Raw cosine similarity over sparse tag→weight vectors. Range −1..1. */
export function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of Object.keys(a)) {
    const av = a[k];
    na += av * av;
    const bv = b[k];
    if (bv !== undefined) dot += av * bv;
  }
  for (const k of Object.keys(b)) nb += b[k] * b[k];
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Contract-shaped similarity (doc §6 "cosine over sparse tags"), mapped into
 * 0..1 for scoring:
 * - empty user vector (new user, no swipes) → neutral 0.5 so freshness/palette
 *   drive the order instead of zeroing every score;
 * - otherwise (cos + 1) / 2, preserving order and letting learned dislikes
 *   (negative weights) push scores below neutral.
 */
export function attributeSimilarity(
  userStyleTags: Record<string, number>,
  listingAttributeVector: Record<string, number>,
): number {
  if (isEmptyVector(userStyleTags) || isEmptyVector(listingAttributeVector)) return 0.5;
  return (cosineSimilarity(userStyleTags, listingAttributeVector) + 1) / 2;
}

/** Per-verdict learning weights for swipe events. */
export const SWIPE_VERDICT_WEIGHT: Record<SwipeEvent['verdict'], number> = {
  like: 1,
  save: 1.25,
  dislike: -1,
  skip: -0.2,
};

/** EMA-style learning rate for folding one swipe into the profile vector. */
export const SWIPE_LEARNING_RATE = 0.25;
/** Weights are clamped to keep any single tag from dominating. */
export const STYLE_WEIGHT_CLAMP = 2;
/** Tags whose |weight| decays below this are pruned (keeps the vector sparse). */
export const STYLE_WEIGHT_PRUNE = 0.01;

/**
 * Fold swipe events into the learned style vector (doc §6: swipe
 * like/dislike events → profile style vector). Deterministic, order-sensitive
 * (later swipes matter as much as earlier ones — simple additive EMA).
 */
export function updateStyleVector(
  current: Record<string, number>,
  events: SwipeSignal[],
): Record<string, number> {
  const next: Record<string, number> = { ...current };
  for (const ev of events) {
    const verdictWeight = SWIPE_VERDICT_WEIGHT[ev.verdict];
    if (!verdictWeight) continue;
    for (const [tag, w] of Object.entries(ev.attributeVector)) {
      const delta = SWIPE_LEARNING_RATE * verdictWeight * w;
      const v = (next[tag] ?? 0) + delta;
      next[tag] = Math.max(-STYLE_WEIGHT_CLAMP, Math.min(STYLE_WEIGHT_CLAMP, v));
    }
  }
  for (const tag of Object.keys(next)) {
    if (Math.abs(next[tag]) < STYLE_WEIGHT_PRUNE) delete next[tag];
  }
  return next;
}

/** v1 backend: sparse attribute-tag vectors, cosine in TS. */
export const attributeStyleSimilarity: StyleSimilarity = {
  kind: 'attribute-v1',
  score: attributeSimilarity,
  updateFromSwipes: updateStyleVector,
};

function isEmptyVector(v: Record<string, number>): boolean {
  for (const k in v) if (v[k] !== 0) return false;
  return true;
}
