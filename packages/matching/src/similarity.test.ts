import { describe, expect, it } from 'vitest';
import {
  attributeSimilarity,
  attributeStyleSimilarity,
  cosineSimilarity,
  updateStyleVector,
} from './similarity';

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = { 'silhouette:slip': 1, 'color:blue': 0.8 };
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity({ a: 1 }, { b: 1 })).toBe(0);
  });

  it('opposed vectors → −1', () => {
    expect(cosineSimilarity({ a: 1 }, { a: -1 })).toBeCloseTo(-1, 10);
  });

  it('empty vector → 0', () => {
    expect(cosineSimilarity({}, { a: 1 })).toBe(0);
  });

  it('scale-invariant', () => {
    expect(cosineSimilarity({ a: 2, b: 4 }, { a: 1, b: 2 })).toBeCloseTo(1, 10);
  });
});

describe('attributeSimilarity (0..1 mapping)', () => {
  it('new user (empty style tags) → neutral 0.5', () => {
    expect(attributeSimilarity({}, { 'color:blue': 0.8 })).toBe(0.5);
  });

  it('liked tags score above neutral, disliked below', () => {
    const user = { 'silhouette:slip': 1, 'color:red': -0.8 };
    const slipDress = { 'silhouette:slip': 1 };
    const redDress = { 'color:red': 0.8 };
    expect(attributeSimilarity(user, slipDress)).toBeGreaterThan(0.5);
    expect(attributeSimilarity(user, redDress)).toBeLessThan(0.5);
  });

  it('stays within 0..1', () => {
    expect(attributeSimilarity({ a: 1 }, { a: 1 })).toBe(1);
    expect(attributeSimilarity({ a: 1 }, { a: -1 })).toBe(0);
  });
});

describe('updateStyleVector (swipes → profile vector)', () => {
  const dress = { 'silhouette:wrap': 1, 'color:green': 0.8 };

  it('likes push tags up, dislikes push them down', () => {
    const afterLike = updateStyleVector({}, [{ verdict: 'like', attributeVector: dress }]);
    expect(afterLike['silhouette:wrap']).toBeGreaterThan(0);
    const afterDislike = updateStyleVector({}, [
      { verdict: 'dislike', attributeVector: dress },
    ]);
    expect(afterDislike['silhouette:wrap']).toBeLessThan(0);
  });

  it('save weighs more than like; skip is a mild negative', () => {
    const like = updateStyleVector({}, [{ verdict: 'like', attributeVector: dress }]);
    const save = updateStyleVector({}, [{ verdict: 'save', attributeVector: dress }]);
    const skip = updateStyleVector({}, [{ verdict: 'skip', attributeVector: dress }]);
    expect(save['silhouette:wrap']).toBeGreaterThan(like['silhouette:wrap']);
    expect(skip['silhouette:wrap']).toBeLessThan(0);
    expect(Math.abs(skip['silhouette:wrap'])).toBeLessThan(Math.abs(like['silhouette:wrap']));
  });

  it('is deterministic and clamps runaway weights', () => {
    const manyLikes = Array.from({ length: 100 }, () => ({
      verdict: 'like' as const,
      attributeVector: dress,
    }));
    const a = updateStyleVector({}, manyLikes);
    const b = updateStyleVector({}, manyLikes);
    expect(a).toEqual(b);
    expect(a['silhouette:wrap']).toBeLessThanOrEqual(2);
  });

  it('prunes near-zero weights to keep the vector sparse', () => {
    const after = updateStyleVector({ 'color:green': 0.2 }, [
      { verdict: 'dislike', attributeVector: { 'color:green': 0.8 } },
    ]);
    // 0.2 − 0.25·0.8 = 0 → pruned from the sparse map entirely
    expect('color:green' in after).toBe(false);
  });

  it('does not mutate the input vector', () => {
    const current = { 'color:green': 0.5 };
    updateStyleVector(current, [{ verdict: 'like', attributeVector: dress }]);
    expect(current).toEqual({ 'color:green': 0.5 });
  });
});

describe('StyleSimilarity interface (FashionSigLIP seam)', () => {
  it('v1 backend is tagged and wired to the pure functions', () => {
    expect(attributeStyleSimilarity.kind).toBe('attribute-v1');
    expect(attributeStyleSimilarity.score({}, {})).toBe(0.5);
    const updated = attributeStyleSimilarity.updateFromSwipes({}, [
      { verdict: 'like', attributeVector: { 'vibe:romantic': 1 } },
    ]);
    expect(updated['vibe:romantic']).toBeGreaterThan(0);
  });
});
