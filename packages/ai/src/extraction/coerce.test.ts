import { describe, expect, it } from 'vitest';
import { coerceExtractionOutput } from './coerce';
import { ExtractionModelOutputSchema } from './prompt';

/** A fully valid payload to mutate per-test. */
function validPayload(): Record<string, unknown> {
  return {
    lengthClass: 'midi',
    lengthInches: 44,
    measurements: { bust: 36, waist: null, hip: null, length: 44 },
    colors: [{ name: 'navy', family: 'blue', hex: '#000080' }],
    fabric: 'silk',
    neckline: 'v_neck',
    silhouette: 'slip',
    sleeve: 'sleeveless',
    pattern: 'solid',
    occasions: ['cocktail'],
    audience: 'adult',
    confidence: 0.9,
  };
}

function coerceAndValidate(payload: unknown) {
  return ExtractionModelOutputSchema.parse(coerceExtractionOutput(payload));
}

describe('coerceExtractionOutput — synthetic invalid payloads', () => {
  it('passes a valid payload through unchanged', () => {
    const out = coerceAndValidate(validPayload());
    expect(out).toEqual(validPayload());
  });

  it("invalid silhouette → 'other' (the enum has it) — the observed live failure", () => {
    const out = coerceAndValidate({ ...validPayload(), silhouette: 'fit-and-flare midi' });
    expect(out.silhouette).toBe('other');
  });

  it('near-miss silhouette is normalized instead of discarded (case/hyphens)', () => {
    expect(coerceAndValidate({ ...validPayload(), silhouette: 'A-Line' }).silhouette).toBe('a_line');
    expect(coerceAndValidate({ ...validPayload(), silhouette: 'fit and flare' }).silhouette).toBe(
      'fit_and_flare',
    );
  });

  it('invalid occasions items are dropped, valid ones kept — the observed live failure', () => {
    const out = coerceAndValidate({
      ...validPayload(),
      occasions: ['cocktail', 'garden party', 'wedding_guest', 42],
    });
    expect(out.occasions).toEqual(['cocktail', 'wedding_guest']);
  });

  it('invalid neckline/sleeve/pattern → null (no other in those enums)', () => {
    const out = coerceAndValidate({
      ...validPayload(),
      neckline: 'plunging',
      sleeve: 'dolman',
      pattern: 'chevron-ish',
    });
    expect(out.neckline).toBeNull();
    expect(out.sleeve).toBeNull();
    expect(out.pattern).toBeNull();
  });

  it('invalid lengthClass → null (no other in the enum)', () => {
    const out = coerceAndValidate({ ...validPayload(), lengthClass: 'tea-length-ish' });
    expect(out.lengthClass).toBeNull();
  });

  it('malformed color items are dropped; hex of wrong type nulled', () => {
    const out = coerceAndValidate({
      ...validPayload(),
      colors: [
        { name: 'navy', family: 'blue', hex: 42 }, // bad hex → null
        { name: 'red' }, // missing family → dropped
        'blue', // not an object → dropped
        { name: 'sage', family: 'green', hex: null },
      ],
    });
    expect(out.colors).toEqual([
      { name: 'navy', family: 'blue', hex: null },
      { name: 'sage', family: 'green', hex: null },
    ]);
  });

  it('wrong-typed scalars are nulled; string confidence defaults to 0.5', () => {
    const out = coerceAndValidate({
      ...validPayload(),
      lengthInches: '44 inches',
      fabric: 12,
      confidence: 'high',
      measurements: { bust: '36', waist: 28, hip: null, length: null },
    });
    expect(out.lengthInches).toBeNull();
    expect(out.fabric).toBeNull();
    expect(out.confidence).toBe(0.5);
    expect(out.measurements).toEqual({ bust: null, waist: 28, hip: null, length: null });
  });

  it('missing fields are filled with safe defaults', () => {
    const out = coerceAndValidate({ silhouette: 'slip' });
    expect(out.lengthClass).toBeNull();
    expect(out.colors).toEqual([]);
    expect(out.occasions).toEqual([]);
    expect(out.measurements).toEqual({ bust: null, waist: null, hip: null, length: null });
  });

  it('unrecoverable payloads (non-objects) are returned as-is and still fail validation', () => {
    for (const junk of [null, 'a string', 42, ['array']]) {
      expect(ExtractionModelOutputSchema.safeParse(coerceExtractionOutput(junk)).success).toBe(
        false,
      );
    }
  });
});
