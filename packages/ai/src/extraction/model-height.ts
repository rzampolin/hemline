/**
 * Deterministic stated-model-height pre-parser — length estimation v2.
 *
 * Many brand PDPs state the vision pass's missing anchor: "Model is 5'10" and
 * wears a size S" (Staud, Reformation, Sister Jane…). This parser extracts
 * {modelHeightInches, modelSizeWorn} from listing title + description so the
 * vision length-estimation prompt can anchor on the ACTUAL model height
 * instead of the assumed 5'9" default. It is free/deterministic — the CLI
 * reports its coverage BEFORE quoting any API spend.
 *
 * Handles: 5'10" · 5'10'' · 5 ft 10 · 5 feet 10 inches · 175cm / 175 cm ·
 * unicode quotes/primes (5’10”, 5′10″) · "model is/wears/wearing",
 * "our model", "she is 5'10''", "height of model: 178cm".
 *
 * Guard rails:
 * - a height token only counts when model context ("model", "she", "her",
 *   "mannequin", "height", "wears"…) appears nearby — a bare "Length: 175cm"
 *   garment measurement never matches;
 * - a garment-measurement label immediately before the number ("Length:",
 *   "bust", "hem"…) vetoes the match even with model context in the window;
 * - sanity range 5'2"–6'2" (62–74"); out-of-range candidates are skipped.
 */

export interface ParsedModelInfo {
  /** stated model height, inches (rounded to 0.1); null when not parseable */
  modelHeightInches: number | null;
  /** normalized size the model wears ('S', '4', 'US 4', …); null when absent */
  modelSizeWorn: string | null;
  /** raw matched snippets, for audit/debug */
  matches: string[];
}

/** Sanity range for a stated model height: 5'2" – 6'2". */
export const MODEL_HEIGHT_RANGE_IN = { min: 62, max: 74 } as const;

/** Map curly quotes / primes / modifier letters to plain ASCII quote marks. */
function normalizeQuotes(text: string): string {
  return text
    .replace(/[‘’′ʼ´`]/g, "'")
    .replace(/[“”″]/g, '"');
}

interface HeightPattern {
  re: RegExp;
  toInches(m: RegExpExecArray): number | null;
}

const HEIGHT_PATTERNS: HeightPattern[] = [
  // 5'10" · 5'10'' · 5'10 · 5' 10 (quotes already normalized)
  {
    re: /(\d)\s*'\s*(\d{1,2}(?:\.\d)?)\s*(?:"|''|in\b|inch(?:es)?)?/gi,
    toInches: (m) => Number(m[1]) * 12 + Number(m[2]),
  },
  // 5 ft 10 · 5ft10in · 5 feet 10 inches · 6 feet (inches optional)
  {
    re: /(\d)\s*(?:ft\.?|feet|foot)\s*(\d{1,2}(?:\.\d)?)?\s*(?:"|''|in\b|inch(?:es)?)?/gi,
    toInches: (m) => Number(m[1]) * 12 + Number(m[2] ?? 0),
  },
  // 175cm / 175 cm (stated heights are always 3 digits in cm)
  {
    re: /(\d{3}(?:[.,]\d)?)\s*cm\b/gi,
    toInches: (m) => Number(m[1].replace(',', '.')) / 2.54,
  },
];

/**
 * Model context that must appear shortly BEFORE the height token
 * ("model is 5'10"", "she's 175cm", "height of model: 178 cm", "her height",
 * "mannequin: 175 cm" for FR listings, "wears a size S and is 5'10"").
 */
const CONTEXT_BEFORE = /\b(?:model|models|mannequin|she|she's|her|height|wears|wearing|tall)\b/i;
/** …or shortly AFTER it ("the 5'10" model", "175 cm tall"). */
const CONTEXT_AFTER = /\b(?:tall|model|mannequin)\b/i;
const CONTEXT_BEFORE_WINDOW = 50;
const CONTEXT_AFTER_WINDOW = 26;

/**
 * Veto: a garment-measurement label directly before the number means the
 * value measures the DRESS, not the model — even when "model" appears earlier
 * in the same sentence ("Model wears size S. Length: 175 cm").
 */
const GARMENT_LABEL_VETO =
  /(?:length|long|bust|waist|hips?|hem|chest|shoulders?|sleeves?|inseam|rise|measure(?:s|ments?)?)\s*[:\-–]?\s*(?:approx\.?|about|~)?\s*$/i;
const VETO_WINDOW = 26;

interface HeightCandidate {
  index: number;
  inches: number;
  snippet: string;
}

function findHeight(text: string): HeightCandidate | null {
  const candidates: HeightCandidate[] = [];
  for (const pattern of HEIGHT_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(text)) !== null) {
      const raw = pattern.toInches(m);
      if (raw == null || !Number.isFinite(raw)) continue;
      const inches = Math.round(raw * 10) / 10;
      if (inches < MODEL_HEIGHT_RANGE_IN.min || inches > MODEL_HEIGHT_RANGE_IN.max) continue;

      const before = text.slice(Math.max(0, m.index - CONTEXT_BEFORE_WINDOW), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + CONTEXT_AFTER_WINDOW);
      if (!CONTEXT_BEFORE.test(before) && !CONTEXT_AFTER.test(after)) continue;

      const immediateBefore = text.slice(Math.max(0, m.index - VETO_WINDOW), m.index);
      if (GARMENT_LABEL_VETO.test(immediateBefore)) continue;

      candidates.push({ index: m.index, inches, snippet: m[0].trim() });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
}

// ── size worn ───────────────────────────────────────────────────────────────

const ALPHA_SIZES = new Set(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL']);
const SIZE_WORDS: Record<string, string> = {
  'small': 'S',
  'medium': 'M',
  'large': 'L',
  'x-small': 'XS',
  'xsmall': 'XS',
  'extra small': 'XS',
  'extra-small': 'XS',
  'x-large': 'XL',
  'xlarge': 'XL',
  'extra large': 'XL',
  'extra-large': 'XL',
};

const SIZE_PATTERNS: RegExp[] = [
  // "wears a size S" · "wearing size 36" — explicit wear verb + 'size' keyword
  /(?:wears?|wearing)\s+(?:a\s+|an\s+)?size\s+((?:US|UK|EU|FR|IT|AU)\s*\d{1,2}|[A-Za-z][A-Za-z-]{0,12}|\d{1,2})/gi,
  // "model … wears an XS" · "she is wearing a small" · "model … in a size 6"
  // — model subject required, size token whitelisted ("available in size M"
  //   has no model subject and never matches here)
  /(?:model|mannequin|she)\b[^.;\n]{0,50}?(?:wear(?:s|ing)?|in)\s+(?:a\s+|an\s+)?(?:size\s+)?((?:US|UK|EU|FR|IT|AU)\s*\d{1,2}|XXS|XS|S|M|L|XL|XXL|extra[\s-](?:small|large)|x[\s-]?small|x[\s-]?large|small|medium|large|\d{1,2})\b/gi,
];

function normalizeSize(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  const lower = trimmed.toLowerCase();
  if (SIZE_WORDS[lower]) return SIZE_WORDS[lower];
  const region = /^(US|UK|EU|FR|IT|AU)\s*(\d{1,2})$/i.exec(trimmed);
  if (region) return `${region[1].toUpperCase()} ${region[2]}`;
  if (/^\d{1,2}$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 0 && n <= 58 ? String(n) : null; // covers US 0–24 and EU 32–46
  }
  const upper = trimmed.toUpperCase();
  return ALPHA_SIZES.has(upper) ? upper : null;
}

function findSizeWorn(text: string): { size: string; snippet: string } | null {
  for (const pattern of SIZE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const size = normalizeSize(m[1]);
      if (size != null) return { size, snippet: m[0].trim() };
    }
  }
  return null;
}

/**
 * Extract the stated model height + size worn from listing title/description
 * text. Deterministic and free — safe to run over the whole catalog for
 * coverage reporting before any API spend.
 */
export function parseModelInfo(text: string | null | undefined): ParsedModelInfo {
  const result: ParsedModelInfo = {
    modelHeightInches: null,
    modelSizeWorn: null,
    matches: [],
  };
  if (!text) return result;
  const normalized = normalizeQuotes(text);

  const height = findHeight(normalized);
  if (height) {
    result.modelHeightInches = height.inches;
    result.matches.push(height.snippet);
  }
  const size = findSizeWorn(normalized);
  if (size) {
    result.modelSizeWorn = size.size;
    result.matches.push(size.snippet);
  }
  return result;
}
