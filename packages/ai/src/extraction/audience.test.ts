/**
 * Audience field through the extraction stack (kids-in-catalog, 2026-07-09):
 * model schema, keyword fallback for the mock engine, coercion, finalize.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractionInput } from '@hemline/contracts';
import { coerceExtractionOutput } from './coerce';
import { finalizeModelOutput, mockExtract } from './index';
import { parseMeasurements } from './measurements';
import { EXTRACTION_SYSTEM_PROMPT, ExtractionModelOutputSchema } from './prompt';
import { audienceFromText } from './taxonomy';

function input(title: string, description = ''): ExtractionInput {
  return {
    contentHash: 'h',
    title,
    description,
    brand: null,
    primaryImageUrl: null,
    attributeHints: null,
    sizeLabels: [],
  };
}

describe('audienceFromText — mock keyword fallback', () => {
  it.each(['Girls Decker Cotton Floral Dress', 'Toddler Twirl Dress', 'Kids Gingham Dress', 'Mini Me Floral Dress'])(
    'child: %s',
    (t) => expect(audienceFromText(t)).toBe('child'),
  );
  it.each([
    'Serena Mini Dress',
    'Baby Blue Midi Dress',
    'Babydoll Mini Dress',
    'Baby Doll Dress',
    'Girls Night Out Dress',
    'Girl Boss Shift Dress',
    'Little Black Dress',
  ])('null (adult trap): %s', (t) => expect(audienceFromText(t)).toBeNull());
});

describe('mockExtract — audience', () => {
  it('flags a kid title as child', () => {
    expect(mockExtract(input('Girls Smocked Party Dress')).audience).toBe('child');
  });
  it('never flags from the DESCRIPTION (adult cross-sell copy)', () => {
    const attrs = mockExtract(
      input('Floral Midi Dress', 'Shop the mini me version for your little one!'),
    );
    expect(attrs.audience).toBeNull();
  });
  it('adult traps stay null', () => {
    expect(mockExtract(input('Babydoll Baby Blue Mini Dress')).audience).toBeNull();
  });
});

describe('model schema + prompt + coercion', () => {
  it('the model-facing schema requires the audience enum', () => {
    const parsed = ExtractionModelOutputSchema.safeParse({
      lengthClass: 'midi',
      lengthInches: null,
      measurements: { bust: null, waist: null, hip: null, length: null },
      colors: [],
      fabric: null,
      neckline: null,
      silhouette: null,
      sleeve: null,
      pattern: null,
      occasions: [],
      audience: 'child',
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.audience).toBe('child');
  });

  it('the system prompt instructs the audience classification', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/audience/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/babydoll/i);
  });

  it('coercion maps an invalid audience to null and keeps valid values', () => {
    const coerced = coerceExtractionOutput({ audience: 'children', occasions: [] }) as {
      audience: unknown;
    };
    expect(coerced.audience).toBeNull();
    const kept = coerceExtractionOutput({ audience: 'child', occasions: [] }) as {
      audience: unknown;
    };
    expect(kept.audience).toBe('child');
  });

  it('finalizeModelOutput carries the audience into the contract shape', () => {
    const output = ExtractionModelOutputSchema.parse({
      lengthClass: null,
      lengthInches: null,
      measurements: { bust: null, waist: null, hip: null, length: null },
      colors: [],
      fabric: null,
      neckline: null,
      silhouette: null,
      sleeve: null,
      pattern: null,
      occasions: [],
      audience: 'child',
      confidence: 0.8,
    });
    const attrs = finalizeModelOutput(output, parseMeasurements(''), input('Girls Dress'));
    expect(attrs.audience).toBe('child');
  });
});
