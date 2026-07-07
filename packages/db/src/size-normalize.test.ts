import { describe, expect, it } from 'vitest';
import { normalizeSizeLabel, normalizeSizeLabels } from './size-normalize';

describe('normalizeSizeLabel', () => {
  it('maps US numeric labels to themselves', () => {
    expect(normalizeSizeLabel('8')).toEqual([8]);
    expect(normalizeSizeLabel('0')).toEqual([0]);
    expect(normalizeSizeLabel('00')).toEqual([0]);
    expect(normalizeSizeLabel('16')).toEqual([16]);
    expect(normalizeSizeLabel('US 12')).toEqual([12]);
    expect(normalizeSizeLabel('Size 4')).toEqual([4]);
  });

  it('straddles odd (juniors) sizes', () => {
    expect(normalizeSizeLabel('7')).toEqual([6, 8]);
  });

  it('maps alpha sizes per the fixture convention', () => {
    expect(normalizeSizeLabel('XS')).toEqual([0, 2]);
    expect(normalizeSizeLabel('S')).toEqual([4, 6]);
    expect(normalizeSizeLabel('m')).toEqual([8, 10]);
    expect(normalizeSizeLabel('L')).toEqual([12, 14]);
    expect(normalizeSizeLabel('XL')).toEqual([16]);
    expect(normalizeSizeLabel('M+')).toEqual([8, 10]); // Sister Jane "M+"
  });

  it('normalizes junk to nothing instead of guessing', () => {
    expect(normalizeSizeLabel('One Size')).toEqual([]);
    expect(normalizeSizeLabel('Blue, Black')).toEqual([]); // color leaked into size option
    expect(normalizeSizeLabel('EU 38')).toEqual([]);
    expect(normalizeSizeLabel('44')).toEqual([]); // out of US dress range
    expect(normalizeSizeLabel('')).toEqual([]);
  });
});

describe('normalizeSizeLabels', () => {
  it('dedupes, sorts and tolerates junk', () => {
    expect(normalizeSizeLabels(['XS', 'S', 'M', 'L', 'XL'])).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(normalizeSizeLabels(['Z', 'S', 'M', 'M+'])).toEqual([4, 6, 8, 10]);
    expect(normalizeSizeLabels(['00', '0', '2'])).toEqual([0, 2]);
    expect(normalizeSizeLabels([])).toEqual([]);
  });
});
