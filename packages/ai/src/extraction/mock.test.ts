/**
 * MockExtractor accuracy against the fixture corpus (150 listings with
 * ground-truth pre-baked extractions) + determinism.
 *
 * Ground-truth caveat: the fixture generator baked attributes that are not
 * always present in the listing text (image-only necklines/sleeves, hidden
 * lengths behind "Falls to a midi length", ±1″ noise on measurements). The
 * thresholds below assert the text-derivable performance; the raw all-field
 * numbers are printed for the report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExtractedAttributes, ExtractionInput, RawListing } from '@hemline/contracts';
import { ExtractedAttributesSchema } from '@hemline/contracts';
import { mockExtract, MOCK_CONFIDENCE_CAP } from './mock';

interface Fixture {
  raw: RawListing;
  extraction: ExtractedAttributes;
}

// The fixture corpus (with pre-baked ground-truth extractions) is the repo's
// shared test dataset — read directly; the connectors package doesn't export it.
const fixturesPath = fileURLToPath(
  new URL('../../../connectors/src/fixtures/listings.json', import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixture[];

function inputFor(fx: Fixture): ExtractionInput {
  return {
    contentHash: fx.raw.sourceListingId,
    title: fx.raw.title,
    description: fx.raw.description ?? null,
    brand: fx.raw.brand ?? null,
    primaryImageUrl: fx.raw.imageUrls[0] ?? null,
    attributeHints: null,
    sizeLabels: fx.raw.sizeLabels,
  };
}

describe('mockExtract — contract & determinism', () => {
  it('outputs contract-valid attributes for every fixture', () => {
    for (const fx of fixtures) {
      const attrs = mockExtract(inputFor(fx));
      expect(() => ExtractedAttributesSchema.parse(attrs)).not.toThrow();
      expect(attrs.confidence).toBeLessThanOrEqual(MOCK_CONFIDENCE_CAP);
    }
  });

  it('is deterministic: identical input → identical output', () => {
    const input = inputFor(fixtures[0]);
    expect(mockExtract(input)).toEqual(mockExtract({ ...input }));
  });

  it('classifies a plain keyword listing end-to-end', () => {
    const attrs = mockExtract({
      contentHash: 'x',
      title: 'Vintage 1970s Emerald Green Silk Wrap Midi Dress',
      description: 'Beautiful v-neck, long sleeves. Pit to pit 19", length 44 inches.',
      brand: null,
      primaryImageUrl: null,
      attributeHints: null,
      sizeLabels: ['M'],
    });
    expect(attrs.lengthClass).toBe('midi');
    expect(attrs.lengthInches).toBe(44);
    expect(attrs.measurements.bust).toBe(38);
    expect(attrs.silhouette).toBe('wrap');
    expect(attrs.neckline).toBe('v_neck');
    expect(attrs.sleeve).toBe('long');
    expect(attrs.fabric).toBe('silk');
    expect(attrs.colors.map((c) => c.name)).toContain('emerald');
    expect(attrs.attributeVector['silhouette:wrap']).toBe(1);
    expect(attrs.attributeVector['length:midi']).toBe(1);
    expect(attrs.attributeVector['era:vintage']).toBeUndefined(); // vector comes from attrs only unless hinted
  });

  it('respects connector attributeHints over its own guesses', () => {
    const attrs = mockExtract({
      contentHash: 'x',
      title: 'Pretty Midi Dress',
      description: null,
      brand: null,
      primaryImageUrl: null,
      attributeHints: { lengthClass: 'maxi', silhouette: 'slip' },
      sizeLabels: [],
    });
    expect(attrs.lengthClass).toBe('maxi');
    expect(attrs.silhouette).toBe('slip');
  });

  it('derives length class from parsed inches when no keyword exists', () => {
    const attrs = mockExtract({
      contentHash: 'x',
      title: 'Silk slip dress',
      description: 'length 33"',
      brand: null,
      primaryImageUrl: null,
      attributeHints: null,
      sizeLabels: [],
    });
    expect(attrs.lengthClass).toBe('mini');
  });
});

describe('mockExtract — accuracy vs fixture ground truth', () => {
  interface FieldStat {
    ok: number;
    total: number;
  }
  const stats = new Map<string, FieldStat>();
  const bump = (field: string, ok: boolean) => {
    const s = stats.get(field) ?? { ok: 0, total: 0 };
    s.total++;
    if (ok) s.ok++;
    stats.set(field, s);
  };
  const pct = (field: string) => {
    const s = stats.get(field)!;
    return s.ok / s.total;
  };

  /** Is the ground-truth value literally present in the listing text? */
  const derivable = (gt: string | null, text: string) =>
    gt !== null && new RegExp(gt.replace(/_/g, '[ _-]?'), 'i').test(text);

  it('scores every fixture', () => {
    for (const fx of fixtures) {
      const text = `${fx.raw.title} ${fx.raw.description ?? ''}`;
      const got = mockExtract(inputFor(fx));
      const gt = fx.extraction;

      bump('lengthClass', got.lengthClass === gt.lengthClass);
      bump('silhouette', got.silhouette === gt.silhouette);
      bump('pattern', got.pattern === gt.pattern);
      bump('fabric', got.fabric === gt.fabric);
      for (const field of ['neckline', 'sleeve'] as const) {
        bump(`${field}(raw)`, got[field] === gt[field]);
        if (gt[field] === null || derivable(gt[field], text)) {
          bump(`${field}(text-derivable)`, got[field] === gt[field]);
        }
      }
      // colors: at least half the GT color names recovered
      const gtNames = new Set(gt.colors.map((c) => c.name));
      const gotNames = new Set(got.colors.map((c) => c.name));
      const hit = [...gtNames].filter((n) => gotNames.has(n)).length;
      bump('colors(≥half names)', hit >= Math.ceil(gtNames.size / 2));
      // measurements: ±1.5″ when the text mentions them (generator adds ±1 noise)
      for (const m of ['bust', 'waist', 'hip'] as const) {
        if (gt.measurements[m] !== null && /pit|waist|hip/i.test(text)) {
          bump(
            `measurements.${m}`,
            got.measurements[m] !== null &&
              Math.abs(got.measurements[m]! - gt.measurements[m]!) <= 1.5,
          );
        }
      }
      // lengthInches: ±0.5″ when digits are actually in the text
      if (gt.lengthInches !== null && /length:?\s*\d/i.test(text)) {
        bump(
          'lengthInches(stated)',
          got.lengthInches !== null && Math.abs(got.lengthInches - gt.lengthInches) <= 0.5,
        );
      }
      // occasions: ≥1 overlap when any occasion signal exists in the text
      if (gt.occasions.length > 0 && /perfect for/i.test(text)) {
        bump('occasions(≥1)', got.occasions.some((o) => gt.occasions.includes(o)));
      }
    }

    // Print the scorecard for the EM report.
    let totalOk = 0;
    let total = 0;
    const lines: string[] = [];
    for (const [field, s] of [...stats.entries()].sort()) {
      lines.push(`  ${field}: ${s.ok}/${s.total} (${((100 * s.ok) / s.total).toFixed(1)}%)`);
      if (!field.includes('(raw)')) {
        totalOk += s.ok;
        total += s.total;
      }
    }

    console.log(`\nMockExtractor accuracy vs ${fixtures.length} fixture ground truths:`);
    console.log(lines.join('\n'));
    console.log(
      `  OVERALL (excluding image-only raw fields): ${totalOk}/${total} (${((100 * totalOk) / total).toFixed(1)}%)\n`,
    );

    // Assertion thresholds — regressions in the rule engine fail the build.
    expect(pct('lengthClass')).toBeGreaterThanOrEqual(0.9);
    expect(pct('silhouette')).toBeGreaterThanOrEqual(0.9);
    expect(pct('pattern')).toBeGreaterThanOrEqual(0.95);
    expect(pct('fabric')).toBeGreaterThanOrEqual(0.9);
    expect(pct('colors(≥half names)')).toBeGreaterThanOrEqual(0.95);
    expect(pct('measurements.bust')).toBeGreaterThanOrEqual(0.95);
    expect(pct('measurements.waist')).toBeGreaterThanOrEqual(0.95);
    expect(pct('measurements.hip')).toBeGreaterThanOrEqual(0.95);
    expect(pct('lengthInches(stated)')).toBeGreaterThanOrEqual(0.95);
    expect(pct('occasions(≥1)')).toBeGreaterThanOrEqual(0.95);
    // image-only fields: perfect on what the text supports
    expect(pct('neckline(text-derivable)')).toBeGreaterThanOrEqual(0.95);
    expect(pct('sleeve(text-derivable)')).toBeGreaterThanOrEqual(0.95);
  });
});
