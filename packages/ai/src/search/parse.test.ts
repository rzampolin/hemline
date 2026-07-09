import { describe, expect, it } from 'vitest';
import {
  COLOR_FAMILIES,
  expandKnownBrand,
  parseQueryDeterministic,
  type ParsedQuery,
} from './parse';

/** Brand labels shaped like the prod catalog's (incl. noisy collection suffixes). */
const KNOWN_BRANDS = [
  'STAUD',
  'STAUD FALL 2025',
  'STAUD SUMMER 2026',
  'Reformation',
  'Christy Dawn',
  'Sister Jane Exclusives',
  'POPPY x Sister Jane',
  'Before The Break by Ghospell',
];

const parse = (q: string, excludeTerms?: string[]): ParsedQuery =>
  parseQueryDeterministic(q, { knownBrands: KNOWN_BRANDS, excludeTerms });

describe('price expressions (hard)', () => {
  it('under $200', () => {
    const p = parse('under $200');
    expect(p.hard.priceMaxCents).toBe(20000);
    expect(p.hard.priceMinCents).toBeUndefined();
    expect(p.signals).toEqual([
      { kind: 'price', term: 'under $200', value: 'under $200', hard: true },
    ]);
    expect(p.residualTokens).toEqual([]);
  });

  it('less than 150', () => {
    expect(parse('less than 150').hard.priceMaxCents).toBe(15000);
  });

  it('over $50 / at least 75', () => {
    expect(parse('over $50').hard.priceMinCents).toBe(5000);
    expect(parse('at least 75').hard.priceMinCents).toBe(7500);
  });

  it('$100-$200 range (and out-of-order bounds)', () => {
    const p = parse('$100-$200');
    expect(p.hard.priceMinCents).toBe(10000);
    expect(p.hard.priceMaxCents).toBe(20000);
    const swapped = parse('$200-$100');
    expect(swapped.hard.priceMinCents).toBe(10000);
    expect(swapped.hard.priceMaxCents).toBe(20000);
  });

  it('between 100 and 200 dollars', () => {
    const p = parse('between 100 and 200 dollars');
    expect(p.hard.priceMinCents).toBe(10000);
    expect(p.hard.priceMaxCents).toBe(20000);
  });

  it('a bare "8-10" is NOT a price (no $ anywhere)', () => {
    const p = parse('8-10');
    expect(p.hard.priceMinCents).toBeUndefined();
    expect(p.hard.priceMaxCents).toBeUndefined();
  });

  it('price expressions never leak into the semantic text', () => {
    expect(parse('black midi under $150').semanticText).toBe('black midi');
  });
});

describe('size expressions (hard)', () => {
  it('size 8 / sz 10 / us 6', () => {
    expect(parse('size 8').hard.sizesNormalized).toEqual([8]);
    expect(parse('sz 10').hard.sizesNormalized).toEqual([10]);
    expect(parse('us 6').hard.sizesNormalized).toEqual([6]);
  });

  it('implausible sizes are ignored', () => {
    expect(parse('size 44').hard.sizesNormalized).toBeUndefined();
  });
});

describe('brand names (hard, matched against known store labels)', () => {
  it('a brand mention expands to every label containing it as a word sequence', () => {
    const p = parse('staud dress');
    expect(p.hard.brands).toEqual(
      expect.arrayContaining(['STAUD', 'STAUD FALL 2025', 'STAUD SUMMER 2026']),
    );
    const sig = p.signals.find((s) => s.kind === 'brand');
    expect(sig).toMatchObject({ term: 'staud', value: 'STAUD', hard: true });
  });

  it('multi-word brands match as bigrams ("sister jane")', () => {
    const p = parse('sister jane midi');
    expect(p.hard.brands).toEqual(
      expect.arrayContaining(['Sister Jane Exclusives', 'POPPY x Sister Jane']),
    );
    expect(p.hard.lengthClasses).toEqual(['midi']);
  });

  it('stopwords never match a brand ("the" ⊄ "Before The Break …")', () => {
    expect(parse('the dress').hard.brands).toBeUndefined();
  });

  it('mid-label words do not match (leading word-sequence only)', () => {
    // "jane" appears in two labels but never leads one
    expect(parse('jane dress').hard.brands).toBeUndefined();
  });

  it('expandKnownBrand validates arbitrary (e.g. LLM-suggested) names', () => {
    expect(expandKnownBrand('reformation', KNOWN_BRANDS)?.canonical).toBe('Reformation');
    expect(expandKnownBrand('Gucci', KNOWN_BRANDS)).toBeNull();
    expect(expandKnownBrand('the', KNOWN_BRANDS)).toBeNull();
  });
});

describe('taxonomy mapping (soft signals + hard length)', () => {
  it('length words become HARD lengthClasses', () => {
    expect(parse('mini').hard.lengthClasses).toEqual(['mini']);
    expect(parse('knee length').hard.lengthClasses).toEqual(['knee']);
    expect(parse('gown').hard.lengthClasses).toEqual(['floor']);
  });

  it('color synonyms map to families (blush→pink, navy→blue) — soft', () => {
    const blush = parse('blush');
    expect(blush.soft.colorFamilies).toEqual(['pink']);
    expect(blush.signals[0]).toMatchObject({ kind: 'color', value: 'pink', hard: false });
    expect(parse('navy').soft.colorFamilies).toEqual(['blue']);
  });

  it('fabric names normalize to their first word', () => {
    expect(parse('silk charmeuse').soft.fabrics).toEqual(['silk']);
    expect(parse('linen').soft.fabrics).toEqual(['linen']);
  });

  it('silhouettes, necklines, patterns, occasions are soft (never hard)', () => {
    const p = parse('floral wrap v-neck for a party');
    expect(p.soft.patterns).toEqual(['floral']);
    expect(p.soft.silhouettes).toEqual(['wrap']);
    expect(p.soft.necklines).toEqual(['v_neck']);
    expect(p.soft.occasions).toEqual(['party']);
    for (const s of p.signals) expect(s.hard).toBe(false);
    expect(p.hard).toEqual({});
  });

  it('occasion synonyms: office→work, beach→vacation, evening→formal', () => {
    expect(parse('office').soft.occasions).toEqual(['work']);
    expect(parse('beach').soft.occasions).toEqual(['vacation']);
    expect(parse('evening').soft.occasions).toEqual(['formal']);
  });
});

describe('residual tokens (lexical + semantic material)', () => {
  it('unmapped vibe words survive; stopwords and "dress" do not', () => {
    const p = parse('something cottagecore for a summer dress');
    expect(p.residualTokens).toEqual(['cottagecore', 'summer']);
  });

  it('a fully-consumed query has no residual', () => {
    expect(parse('pink midi').residualTokens).toEqual([]);
  });
});

describe('excludeTerms (un-chipped → lexical-only)', () => {
  it('an excluded taxonomy term is not interpreted and stays lexical', () => {
    const p = parse('summer formal', ['formal']);
    expect(p.soft.occasions).toEqual([]);
    expect(p.residualTokens).toEqual(expect.arrayContaining(['summer', 'formal']));
    expect(p.signals).toEqual([]);
  });

  it('excluded terms leave the semantic text', () => {
    expect(parse('summer formal', ['formal']).semanticText).toBe('summer');
  });

  it('an excluded price expression drops the filter and its junk tokens', () => {
    const p = parse('black midi under $150', ['under $150']);
    expect(p.hard.priceMaxCents).toBeUndefined();
    expect(p.residualTokens).toEqual([]);
    expect(p.soft.colorFamilies).toEqual(['black']);
  });

  it('an excluded brand stays lexical', () => {
    const p = parse('staud mini', ['staud']);
    expect(p.hard.brands).toBeUndefined();
    expect(p.residualTokens).toContain('staud');
    expect(p.hard.lengthClasses).toEqual(['mini']);
  });
});

describe('COLOR_FAMILIES export', () => {
  it('is the deduped family vocabulary from the extraction color table', () => {
    expect(COLOR_FAMILIES).toEqual(expect.arrayContaining(['pink', 'blue', 'metallic']));
    expect(new Set(COLOR_FAMILIES).size).toBe(COLOR_FAMILIES.length);
  });
});

/* ── the 20-query eval set (docs/decisions-search.md) ───────────────────── */

interface Expected {
  hard?: Partial<ParsedQuery['hard']>;
  soft?: Partial<ParsedQuery['soft']>;
  residual?: string[];
}

const EVAL_SET: Array<[string, Expected]> = [
  ['summer formal', { soft: { occasions: ['formal'] }, residual: ['summer'] }],
  ['petite wedding guest dress', { soft: { occasions: ['wedding_guest'] }, residual: ['petite'] }],
  [
    'black midi under $150',
    { hard: { priceMaxCents: 15000, lengthClasses: ['midi'] }, soft: { colorFamilies: ['black'] }, residual: [] },
  ],
  ['silk slip', { soft: { fabrics: ['silk'], silhouettes: ['slip'] }, residual: [] }],
  ['cottagecore', { residual: ['cottagecore'] }],
  ['something for a work event', { soft: { occasions: ['work'] }, residual: ['event'] }],
  [
    'blush maxi size 12',
    { hard: { sizesNormalized: [12], lengthClasses: ['maxi'] }, soft: { colorFamilies: ['pink'] }, residual: [] },
  ],
  ['STAUD mini', { hard: { lengthClasses: ['mini'], brands: expect.arrayContaining(['STAUD']) as unknown as string[] }, residual: [] }],
  ['pink', { soft: { colorFamilies: ['pink'] }, residual: [] }],
  [
    'red wrap dress under 100 dollars',
    { hard: { priceMaxCents: 10000 }, soft: { colorFamilies: ['red'], silhouettes: ['wrap'] }, residual: [] },
  ],
  [
    'linen midi dress for vacation',
    { hard: { lengthClasses: ['midi'] }, soft: { fabrics: ['linen'], occasions: ['vacation'] }, residual: [] },
  ],
  ['floral maxi', { hard: { lengthClasses: ['maxi'] }, soft: { patterns: ['floral'] }, residual: [] }],
  ['cocktail dress size 8', { hard: { sizesNormalized: [8] }, soft: { occasions: ['cocktail'] }, residual: [] }],
  [
    '$100-$200 wedding guest',
    { hard: { priceMinCents: 10000, priceMaxCents: 20000 }, soft: { occasions: ['wedding_guest'] }, residual: [] },
  ],
  [
    'navy bodycon mini',
    { hard: { lengthClasses: ['mini'] }, soft: { colorFamilies: ['blue'], silhouettes: ['bodycon'] }, residual: [] },
  ],
  [
    'elegant evening gown',
    { hard: { lengthClasses: ['floor'] }, soft: { occasions: ['formal'] }, residual: ['elegant'] },
  ],
  [
    'reformation silk dress',
    { hard: { brands: ['Reformation'] }, soft: { fabrics: ['silk'] }, residual: [] },
  ],
  ['square neck linen dress', { soft: { necklines: ['square'], fabrics: ['linen'] }, residual: [] }],
  ['casual brunch dress', { soft: { occasions: ['brunch', 'casual'] }, residual: [] }],
  [
    'vintage 90s slip dress in emerald',
    { soft: { silhouettes: ['slip'], colorFamilies: ['green'] }, residual: ['vintage', '90s'] },
  ],
];

describe('eval set: deterministic mapper output on all 20 queries', () => {
  it.each(EVAL_SET)('%s', (query, expected) => {
    const p = parse(query);
    for (const [key, value] of Object.entries(expected.hard ?? {})) {
      expect(p.hard[key as keyof ParsedQuery['hard']], `${query} hard.${key}`).toEqual(value);
    }
    for (const [key, value] of Object.entries(expected.soft ?? {})) {
      expect(p.soft[key as keyof ParsedQuery['soft']], `${query} soft.${key}`).toEqual(value);
    }
    if (expected.residual) {
      expect([...p.residualTokens].sort(), `${query} residual`).toEqual(
        [...expected.residual].sort(),
      );
    }
    // the hard/soft split invariant: only price/size/length/brand are hard
    for (const s of p.signals) {
      const shouldBeHard = ['price', 'size', 'length', 'brand'].includes(s.kind);
      expect(s.hard, `${query} → ${s.kind}:${s.value}`).toBe(shouldBeHard);
    }
  });
});
