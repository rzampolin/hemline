/**
 * Deterministic coercion of near-valid extraction model output — Task: fix the
 * enum-validation fallback (2026-07-07 ai-eng).
 *
 * Live Haiku occasionally emits enum values outside the closed vocabularies
 * (observed: silhouette not in the 10 allowed values; occasions items outside
 * the list) even under schema-constrained structured outputs. Discarding the
 * whole extraction for one bad enum wastes a paid, mostly-correct response.
 *
 * Recovery ladder (extraction service):
 *   1. validate → 2. ONE retry with the validation errors fed back →
 *   3. deterministic coercion (this module) → 4. mock fallback (loud log).
 *
 * Coercion rules (deterministic, no model involved):
 *   - invalid enum value → 'other' where the enum contains it, else null
 *   - invalid array items → dropped
 *   - wrong-typed scalars → null (numbers/strings), 0.5 (confidence — unknown)
 * The result is re-validated by the caller; coercion never bypasses the schema.
 */
import { LengthClassSchema, SilhouetteSchema } from '@hemline/contracts';
import { NECKLINES, OCCASIONS, PATTERNS, SLEEVES } from './taxonomy';

const LENGTH_CLASSES: readonly string[] = LengthClassSchema.options;
const SILHOUETTES: readonly string[] = SilhouetteSchema.options;

function coerceEnum(value: unknown, allowed: readonly string[]): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (allowed.includes(value)) return value;
    // normalize the common drift shapes before giving up: case, spaces/hyphens
    const normalized = value.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (allowed.includes(normalized)) return normalized;
  }
  return allowed.includes('other') ? 'other' : null;
}

function coerceNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Best-effort deterministic repair of a raw (JSON-parsed) model payload into
 * the ExtractionModelOutputSchema shape. Returns a candidate the caller MUST
 * re-validate — this function never guarantees validity (e.g. a non-object
 * payload is unrecoverable and returned as-is).
 */
export function coerceExtractionOutput(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;

  const m = (r.measurements ?? {}) as Record<string, unknown>;
  const measurements =
    typeof m === 'object' && !Array.isArray(m)
      ? {
          bust: coerceNumber(m.bust),
          waist: coerceNumber(m.waist),
          hip: coerceNumber(m.hip),
          length: coerceNumber(m.length),
        }
      : { bust: null, waist: null, hip: null, length: null };

  const colors = Array.isArray(r.colors)
    ? r.colors
        .map((c) => {
          if (c == null || typeof c !== 'object' || Array.isArray(c)) return null;
          const cc = c as Record<string, unknown>;
          const name = coerceString(cc.name);
          const family = coerceString(cc.family);
          if (name == null || family == null) return null; // invalid item → dropped
          return { name, family, hex: coerceString(cc.hex) };
        })
        .filter((c): c is { name: string; family: string; hex: string | null } => c != null)
    : [];

  const occasions = Array.isArray(r.occasions)
    ? r.occasions.filter(
        (o): o is (typeof OCCASIONS)[number] =>
          typeof o === 'string' && (OCCASIONS as readonly string[]).includes(o),
      )
    : [];

  return {
    lengthClass: coerceEnum(r.lengthClass, LENGTH_CLASSES), // no 'other' → null
    lengthInches: coerceNumber(r.lengthInches),
    measurements,
    colors,
    fabric: coerceString(r.fabric),
    neckline: coerceEnum(r.neckline, NECKLINES),
    silhouette: coerceEnum(r.silhouette, SILHOUETTES), // has 'other'
    sleeve: coerceEnum(r.sleeve, SLEEVES),
    pattern: coerceEnum(r.pattern, PATTERNS),
    occasions,
    confidence: coerceNumber(r.confidence) ?? 0.5,
  };
}
