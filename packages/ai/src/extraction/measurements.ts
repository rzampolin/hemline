/**
 * Deterministic measurement pre-parser — docs/ARCHITECTURE.md §7.2 / §7.5.
 *
 * Parses free-text garment measurements from listing title + description:
 *   "pit to pit 18\""       → bust 36 (flat × 2)
 *   "length 39 inches"      → length 39
 *   "bust 36in" / "waist 28" / "hips 40"
 *   "waist to hem 24in"     → length 24 measured from waist (§5 edge case)
 *   "100 cm"                → inches (÷2.54)
 *
 * Runs BEFORE the model in live mode: its results are embedded in the prompt
 * as ground truth and verified against the model's answer afterwards (the
 * deterministic value wins on disagreement). It is also the measurement engine
 * of the keyless MockExtractor.
 */
import type { Measurements } from '@hemline/contracts';

export interface ParsedMeasurements extends Measurements {
  /** 'waist' when the length was stated waist-to-hem (use S = 0.62·H_eff). */
  lengthMeasuredFrom: 'hps' | 'waist' | null;
  /** raw matched snippets, for audit/debug */
  matches: string[];
}

const NUM = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
const UNIT = String.raw`\s*(cm|centimeters?|inches|inch|in\b|["”″])?`;

interface Rule {
  field: 'bust' | 'waist' | 'hip' | 'length';
  re: RegExp;
  /** flat (pit-to-pit style, one side of the garment) → double it */
  flat?: boolean;
  /** length measured from the waist, not HPS */
  fromWaist?: boolean;
}

const RULES: Rule[] = [
  // ── length ──────────────────────────────────────────────────────────────
  { field: 'length', re: rx(`waist\\s*to\\s*hem\\s*:?\\s*${NUM}${UNIT}`), fromWaist: true },
  { field: 'length', re: rx(`(?:full\\s+)?length\\s*:?\\s*${NUM}${UNIT}`) },
  { field: 'length', re: rx(`${NUM}${UNIT}\\s*(?:long|from\\s+(?:high\\s+point|shoulder|hps))`) },
  { field: 'length', re: rx(`(?:shoulder|hps)\\s*to\\s*hem\\s*:?\\s*${NUM}${UNIT}`) },
  // ── bust ────────────────────────────────────────────────────────────────
  { field: 'bust', re: rx(`(?:pit\\s*to\\s*pit|armpit\\s*to\\s*armpit|p2p|ptp)\\s*:?\\s*${NUM}${UNIT}`), flat: true },
  { field: 'bust', re: rx(`(?:bust|chest)\\s*:?\\s*${NUM}${UNIT}\\s*flat`), flat: true },
  { field: 'bust', re: rx(`(?:bust|chest)\\s*:?\\s*${NUM}${UNIT}`) },
  // ── waist ───────────────────────────────────────────────────────────────
  { field: 'waist', re: rx(`waist\\s*:?\\s*${NUM}${UNIT}\\s*flat`), flat: true },
  { field: 'waist', re: rx(`waist\\s*:?\\s*${NUM}${UNIT}`) },
  // ── hip ─────────────────────────────────────────────────────────────────
  { field: 'hip', re: rx(`hips?\\s*:?\\s*${NUM}${UNIT}\\s*flat`), flat: true },
  { field: 'hip', re: rx(`hips?\\s*:?\\s*${NUM}${UNIT}`) },
];

function rx(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/** Sanity windows (inches, full circumference / HPS length) to reject noise. */
const PLAUSIBLE: Record<Rule['field'], [number, number]> = {
  bust: [24, 70],
  waist: [18, 65],
  hip: [26, 75],
  length: [20, 75],
};

export function parseMeasurements(text: string): ParsedMeasurements {
  const result: ParsedMeasurements = {
    bust: null,
    waist: null,
    hip: null,
    length: null,
    lengthMeasuredFrom: null,
    matches: [],
  };
  if (!text) return result;

  /**
   * Sellers who write "Flat measurements: pit to pit 21, waist 16" mean flat
   * (one-side) numbers for everything in that sentence, even without a "flat"
   * suffix on each field.
   */
  const flatContext = /flat\s+measurements|measurements\s*\(flat\)|laid\s+flat/i.test(text);

  for (const rule of RULES) {
    if (result[rule.field] !== null) continue;
    const m = rule.re.exec(text);
    if (!m) continue;
    let value = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    const unit = (m[2] ?? '').toLowerCase();
    if (unit.startsWith('cm') || unit.startsWith('centimeter')) value /= 2.54;
    const isFlat =
      rule.flat === true ||
      (flatContext && rule.field !== 'length' && rule.flat !== false && !isFullCircumference(value, rule.field));
    if (isFlat && rule.field !== 'length') value *= 2;
    value = Math.round(value * 10) / 10;

    const [lo, hi] = PLAUSIBLE[rule.field];
    if (value < lo || value > hi) continue;

    result[rule.field] = value;
    result.matches.push(m[0].trim());
    if (rule.field === 'length') {
      result.lengthMeasuredFrom = rule.fromWaist ? 'waist' : 'hps';
    }
  }
  return result;
}

/**
 * Under a "flat measurements" context a bare "waist 16" is flat, but a
 * "waist 32" is already a full circumference — doubling it would be absurd.
 * Values at/above the plausible full-circumference floor are left as-is.
 */
function isFullCircumference(value: number, field: 'bust' | 'waist' | 'hip'): boolean {
  const floors = { bust: 28, waist: 22, hip: 30 };
  return value >= floors[field];
}

/** |a − b| within tolerance; used to verify model output vs the pre-parser. */
export function measurementsAgree(
  a: number | null,
  b: number | null,
  toleranceInches = 1.5,
): boolean {
  if (a === null || b === null) return true; // nothing to disagree about
  return Math.abs(a - b) <= toleranceInches;
}
