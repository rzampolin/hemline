import { describe, expect, it } from 'vitest';
import {
  averageEmbeddings,
  blendSimilarity,
  cosineDense,
  createEmbeddingStyleSimilarity,
  denseToSparse,
  EMBEDDING_BLEND_WEIGHT,
  embeddingSimilarity,
  l2Normalize,
  sparseToDense,
  styleEmbeddingFromSwipes,
} from './embedding';

const f32 = (...v: number[]) => Float32Array.from(v);

describe('cosineDense', () => {
  it('is 1 for parallel, -1 for opposite, 0 for orthogonal vectors', () => {
    expect(cosineDense(f32(1, 0), f32(2, 0))).toBeCloseTo(1);
    expect(cosineDense(f32(1, 0), f32(-3, 0))).toBeCloseTo(-1);
    expect(cosineDense(f32(1, 0), f32(0, 5))).toBeCloseTo(0);
  });

  it('is 0 for zero-length, zero, or dimension-mismatched vectors', () => {
    expect(cosineDense(f32(), f32())).toBe(0);
    expect(cosineDense(f32(0, 0), f32(1, 1))).toBe(0);
    expect(cosineDense(f32(1, 2), f32(1, 2, 3))).toBe(0);
  });
});

describe('embeddingSimilarity', () => {
  it('maps cosine into 0..1: parallel → 1, opposite → 0, orthogonal → 0.5', () => {
    expect(embeddingSimilarity(f32(1, 0), f32(1, 0))).toBeCloseTo(1);
    expect(embeddingSimilarity(f32(1, 0), f32(-1, 0))).toBeCloseTo(0);
    expect(embeddingSimilarity(f32(1, 0), f32(0, 1))).toBeCloseTo(0.5);
  });

  it('is neutral 0.5 when either vector is missing/empty', () => {
    expect(embeddingSimilarity(null, f32(1))).toBe(0.5);
    expect(embeddingSimilarity(f32(1), null)).toBe(0.5);
    expect(embeddingSimilarity(f32(), f32())).toBe(0.5);
  });
});

describe('blendSimilarity', () => {
  it('blends 0.6·embedding + 0.4·attribute when the embedding score exists', () => {
    expect(blendSimilarity(0.5, 1)).toBeCloseTo(EMBEDDING_BLEND_WEIGHT * 1 + 0.4 * 0.5);
    expect(blendSimilarity(1, 0)).toBeCloseTo(0.4);
  });

  it('falls back to the attribute score alone when embedding is null', () => {
    expect(blendSimilarity(0.73, null)).toBe(0.73);
  });
});

describe('l2Normalize / averageEmbeddings', () => {
  it('normalizes to unit length and keeps zero vectors zero', () => {
    const n = l2Normalize(f32(3, 4));
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
    expect([...l2Normalize(f32(0, 0))]).toEqual([0, 0]);
  });

  it('averages with weights and normalizes the result', () => {
    const avg = averageEmbeddings([
      { vector: f32(1, 0), weight: 3 },
      { vector: f32(0, 1), weight: 1 },
    ]);
    expect(avg).not.toBeNull();
    // direction (3,1)/4 normalized
    expect(avg![0] / avg![1]).toBeCloseTo(3);
    expect(Math.hypot(avg![0], avg![1])).toBeCloseTo(1);
  });

  it('returns null for empty input, zero weights, or all-zero vectors', () => {
    expect(averageEmbeddings([])).toBeNull();
    expect(averageEmbeddings([{ vector: f32(1, 2), weight: 0 }])).toBeNull();
    expect(averageEmbeddings([{ vector: f32(0, 0) }])).toBeNull();
  });

  it('skips dimension-mismatched vectors instead of corrupting the mean', () => {
    const avg = averageEmbeddings([{ vector: f32(1, 0) }, { vector: f32(1, 0, 0) }]);
    expect([...avg!]).toEqual([1, 0]);
  });
});

describe('styleEmbeddingFromSwipes', () => {
  it('averages likes and saves (save weighted 1.25×), ignoring dislikes/skips', () => {
    const v = styleEmbeddingFromSwipes([
      { verdict: 'like', vector: f32(1, 0) },
      { verdict: 'save', vector: f32(0, 1) },
      { verdict: 'dislike', vector: f32(-100, -100) },
      { verdict: 'skip', vector: f32(-100, -100) },
    ]);
    expect(v).not.toBeNull();
    // save (1.25) pulls harder than like (1)
    expect(v![1]).toBeGreaterThan(v![0]);
    expect(v![0]).toBeGreaterThan(0);
  });

  it('returns null with no positive swipes', () => {
    expect(styleEmbeddingFromSwipes([{ verdict: 'dislike', vector: f32(1, 0) }])).toBeNull();
    expect(styleEmbeddingFromSwipes([])).toBeNull();
  });
});

describe('dense ↔ sparse serialization (contract boundary)', () => {
  it('round-trips through Record<string, number>', () => {
    const original = f32(0.25, -1.5, 0, 3);
    const back = sparseToDense(denseToSparse(original), 4);
    expect([...back]).toEqual([...original]);
  });

  it('ignores out-of-range / non-integer keys', () => {
    const v = sparseToDense({ '0': 1, '9': 5, '-1': 5, foo: 5, '1.5': 5 }, 2);
    expect([...v]).toEqual([1, 0]);
  });
});

describe('createEmbeddingStyleSimilarity (the StyleSimilarity adapter)', () => {
  const sim = createEmbeddingStyleSimilarity(2);

  it('has the fashion-siglip kind tag', () => {
    expect(sim.kind).toBe('fashion-siglip-v1');
  });

  it('scores via dense cosine mapped 0..1', () => {
    expect(sim.score(denseToSparse(f32(1, 0)), denseToSparse(f32(1, 0)))).toBeCloseTo(1);
    expect(sim.score(denseToSparse(f32(1, 0)), denseToSparse(f32(-1, 0)))).toBeCloseTo(0);
  });

  it('updateFromSwipes pulls the profile toward liked vectors and renormalizes', () => {
    const start = denseToSparse(f32(1, 0));
    const next = sim.updateFromSwipes(start, [
      { verdict: 'like', attributeVector: denseToSparse(f32(0, 1)) },
    ]);
    const v = sparseToDense(next, 2);
    expect(v[1]).toBeGreaterThan(0); // moved toward the liked item
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1); // unit sphere
    // dislike pushes away
    const pushed = sparseToDense(
      sim.updateFromSwipes(next, [{ verdict: 'dislike', attributeVector: denseToSparse(f32(0, 1)) }]),
      2,
    );
    expect(pushed[1]).toBeLessThan(v[1]);
  });
});
