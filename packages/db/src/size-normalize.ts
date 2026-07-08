/**
 * Size-label → US-numeric normalization (side-effect-free, same single-home
 * rule as content-hash.ts). The ingest pipeline populates
 * `listings.size_normalized_json` with this; the fixture seed pre-bakes the
 * identical convention (XS→0/2, S→4/6, M→8/10, L→12/14, XL→16 — see
 * packages/connectors fixtures listings.json).
 *
 * Unknown/junk labels (colors leaking into variant options, "One Size", EU
 * sizes we don't map yet) normalize to nothing; a listing whose labels all
 * fail to parse keeps `[]`, which the candidate query treats as
 * size-unknown ≠ size-mismatch (packages/matching filters.ts rule 3).
 */

const ALPHA_MAP: Record<string, number[]> = {
  XXS: [0],
  XS: [0, 2],
  S: [4, 6],
  M: [8, 10],
  L: [12, 14],
  XL: [16],
  XXL: [18],
  '1X': [16, 18],
  '2X': [20, 22],
  '3X': [24, 26],
};

/**
 * e.g. "US 8", "8", "08", "00", "Size 10" → US numeric size.
 * Leading zeros are consumed separately so SFCC-padded labels ("002", "010",
 * Reformation et al. — decisions-data-eng.md #23) parse to their real size;
 * backtracking still lets bare "0"/"00" capture as size 0.
 */
const NUMERIC_RE = /^(?:us\s*|size\s*)?0*(\d{1,2})$/i;

/** Normalize one raw size label to zero-or-more US numeric sizes. */
export function normalizeSizeLabel(label: string): number[] {
  const t = label.trim();
  if (t === '') return [];
  const numeric = NUMERIC_RE.exec(t);
  if (numeric) {
    const n = Number(numeric[1]);
    // Women's US dress sizes are even 0–26 ("00" parses to 0, its bucket).
    if (n <= 26 && n % 2 === 0) return [n];
    if (n <= 26) return [n - 1, n + 1]; // odd (juniors) sizes straddle
    return [];
  }
  // "0XS" / "00S" (SFCC zero-padded alpha labels) → "XS" / "S"
  const alpha = ALPHA_MAP[t.toUpperCase().replace(/[\s.+]+$/, '').replace(/^0+(?=[A-Z])/, '')];
  return alpha ?? [];
}

/** Normalize a listing's labels; deduped, sorted, junk-tolerant. */
export function normalizeSizeLabels(labels: string[]): number[] {
  const out = new Set<number>();
  for (const label of labels) for (const n of normalizeSizeLabel(label)) out.add(n);
  return [...out].sort((a, b) => a - b);
}
