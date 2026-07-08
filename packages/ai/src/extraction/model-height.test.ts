/**
 * Stated-model-height parser tests — real-world PDP phrasing variants
 * (Staud, Reformation, Sister Jane, Rouje, eBay resale …).
 */
import { describe, expect, it } from 'vitest';
import { MODEL_HEIGHT_RANGE_IN, parseModelInfo } from './model-height';

describe('parseModelInfo — height, real-world phrasings', () => {
  const cases: Array<[string, number | null]> = [
    // feet'inches with straight quotes
    [`Model is 5'10" and wears a size S`, 70],
    [`Our model is 5'9" and wears a size 4`, 69],
    [`She is 5'10'' and wearing a size small`, 70],
    [`Model: 5'9"`, 69],
    [`Model is 5'10 and wears a small`, 70], // no trailing inch mark
    [`The model is 5' 8" wearing a size XS`, 68],
    // unicode quotes and primes
    [`Model is 5’10” and wears a size S`, 70],
    [`She’s 5′10″ and wears an XS`, 70],
    [`Model wears size S and is 5’9’’ tall`, 69],
    // ft / feet spellings
    [`Model wears a US 4 and is 5 ft 10`, 70],
    [`Our model is 5ft10in and wears a size 8`, 70],
    [`Model is 5 feet 10 inches tall`, 70],
    [`She is 6 feet tall and wears a size M`, 72],
    // centimetres
    [`Our model is 175cm and wears a size 36`, 68.9],
    [`Model height: 178 cm`, 70.1],
    [`Height of model: 175 cm. She wears a size S.`, 68.9],
    [`Le mannequin mesure 175 cm et porte une taille 36`, 68.9],
    [`Model is 180cm wearing size M`, 70.9],
    // context after the number
    [`Worn by our 5'11" model in a size S`, 71],
    [`Shown on a 175 cm model`, 68.9],
  ];
  it.each(cases)('%s → %s inches', (text, expected) => {
    expect(parseModelInfo(text).modelHeightInches).toBe(expected);
  });

  it('parses from combined title + description text', () => {
    const info = parseModelInfo(
      `Sylvie Silk Midi Dress\nEffortless bias cut. Model is 5'10" and wears a size S. Dry clean only.`,
    );
    expect(info.modelHeightInches).toBe(70);
    expect(info.modelSizeWorn).toBe('S');
    expect(info.matches.length).toBeGreaterThan(0);
  });
});

describe('parseModelInfo — rejects garment measurements & noise', () => {
  const noMatch: string[] = [
    // garment measurements — no model context
    `Length: 175cm from shoulder to hem`,
    `Dress length 44", bust 36"`,
    `Total length 170 cm, EU 38`,
    // model context present but a garment label vetoes the number
    `Model wears size S. Length: 175 cm`,
    `She loved it! Hem: 168 cm`,
    // out of sanity range (5'2"–6'2")
    `Model is 4'10" and wears a size S`,
    `Model is 6'5" tall`,
    `Our model is 150cm`,
    `Model is 200 cm`,
    // no height at all
    `Beautiful silk midi dress, worn once`,
    ``,
  ];
  it.each(noMatch)('no height in: %s', (text) => {
    expect(parseModelInfo(text).modelHeightInches).toBeNull();
  });

  it('handles null/undefined text', () => {
    expect(parseModelInfo(null).modelHeightInches).toBeNull();
    expect(parseModelInfo(undefined).modelSizeWorn).toBeNull();
  });

  it('sanity range matches the spec (5\'2"–6\'2")', () => {
    expect(MODEL_HEIGHT_RANGE_IN).toEqual({ min: 62, max: 74 });
    expect(parseModelInfo(`Model is 5'2"`).modelHeightInches).toBe(62);
    expect(parseModelInfo(`Model is 6'2"`).modelHeightInches).toBe(74);
  });

  it('picks the first valid model height when several numbers appear', () => {
    const info = parseModelInfo(
      `Model is 5'10" and wears a size S. Garment length 46". Second model is 5'6".`,
    );
    expect(info.modelHeightInches).toBe(70);
  });
});

describe('parseModelInfo — size worn', () => {
  const cases: Array<[string, string | null]> = [
    [`Model is 5'10" and wears a size S`, 'S'],
    [`She wears a size XS`, 'XS'],
    [`wearing size small`, 'S'],
    [`Model is wearing a medium`, 'M'],
    [`She wears an extra small`, 'XS'],
    [`Model wears a US 4`, 'US 4'],
    [`Model is 175cm and wears a size 36`, '36'],
    [`Model wears size UK 8`, 'UK 8'],
    [`Model in a size L`, 'L'],
    [`available in size M only`, null], // stock info, not the model
    [`Model is 5'9" in a size 6`, '6'],
    // rejects nonsense tokens after 'wears a'
    [`Model wears a slip dress beautifully`, null],
    [`Great dress, wears well`, null],
    [`No size info here`, null],
  ];
  it.each(cases)('%s → %s', (text, expected) => {
    expect(parseModelInfo(text).modelSizeWorn).toBe(expected);
  });

  it('size can be present without a height (and vice versa)', () => {
    const sizeOnly = parseModelInfo(`Model wears a size M`);
    expect(sizeOnly.modelSizeWorn).toBe('M');
    expect(sizeOnly.modelHeightInches).toBeNull();

    const heightOnly = parseModelInfo(`Model is 5'10"`);
    expect(heightOnly.modelHeightInches).toBe(70);
    expect(heightOnly.modelSizeWorn).toBeNull();
  });
});
