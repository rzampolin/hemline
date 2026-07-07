/**
 * Swipe → learned style-tag vector (spec E1/E2, ARCHITECTURE §6 "learned
 * sparse vector {tag: weight} from swipes").
 *
 * The matching package doesn't expose a learning function in its frozen
 * surface, so this deterministic incremental rule lives here (backend-eng):
 *   styleTags[tag] += rate(verdict) × listingWeight, clamped to [-1, 1].
 * Rates: like +0.15, save +0.25, dislike −0.15, skip −0.03.
 * Tiny weights (<0.005) are pruned to keep the vector sparse.
 */
import type { SwipeEvent } from '@hemline/contracts';

const RATE: Record<SwipeEvent['verdict'], number> = {
  like: 0.15,
  save: 0.25,
  dislike: -0.15,
  skip: -0.03,
};

export function applySwipesToStyleTags(
  current: Record<string, number>,
  events: SwipeEvent[],
  vectors: Map<string, Record<string, number>>,
): Record<string, number> {
  const next = { ...current };
  for (const e of events) {
    const vec = vectors.get(e.listingId);
    if (!vec) continue;
    const rate = RATE[e.verdict];
    for (const [tag, weight] of Object.entries(vec)) {
      const updated = (next[tag] ?? 0) + rate * weight;
      next[tag] = Math.max(-1, Math.min(1, updated));
    }
  }
  for (const [tag, w] of Object.entries(next)) {
    if (Math.abs(w) < 0.005) delete next[tag];
  }
  return next;
}
