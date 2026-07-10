/**
 * MockExtractor — docs/ARCHITECTURE.md §7.5.
 *
 * Deterministic rule engine used whenever ANTHROPIC_API_KEY is absent or the
 * daily budget is exhausted: regex measurements + keyword taxonomy over
 * title + description. Confidence is capped at 0.4 so downstream consumers
 * can tell mock extractions from live ones. Pure & synchronous — same input
 * always yields the same output.
 */
import type { ColorTag, ExtractedAttributes, ExtractionInput, LengthClass } from '@hemline/contracts';
import { parseMeasurements } from './measurements';
import {
  audienceFromText,
  buildAttributeVector,
  COLOR_TABLE,
  FABRIC_KEYWORDS,
  firstMatch,
  LENGTH_KEYWORDS,
  lengthClassFromInches,
  NECKLINE_KEYWORDS,
  OCCASION_KEYWORDS,
  PATTERN_KEYWORDS,
  SILHOUETTE_KEYWORDS,
  SLEEVE_KEYWORDS,
} from './taxonomy';

/** Mock confidence ceiling (doc §7.5). */
export const MOCK_CONFIDENCE_CAP = 0.4;

export function mockExtract(input: ExtractionInput): ExtractedAttributes {
  const text = `${input.title}\n${input.description ?? ''}`;
  const hints = input.attributeHints ?? {};

  const parsed = parseMeasurements(text);
  const measurements = {
    bust: hints.measurements?.bust ?? parsed.bust,
    waist: hints.measurements?.waist ?? parsed.waist,
    hip: hints.measurements?.hip ?? parsed.hip,
    length: hints.measurements?.length ?? parsed.length,
  };

  // Length: explicit inches (HPS-basis only) > keyword ("mini"/"midi"/…) > hint
  const lengthInches =
    hints.lengthInches ??
    (parsed.lengthMeasuredFrom === 'waist' ? null : parsed.length);
  // A body-copy phrase like "Falls to a mid calf length" is the seller
  // describing the actual garment; it beats a title marketing word ("Midi").
  const fallsTo = /falls\s+to\s+an?\s+([a-z\s-]+?)\s+length/i.exec(text);
  const phraseClass = fallsTo ? firstMatch<LengthClass>(fallsTo[1], LENGTH_KEYWORDS) : null;
  const keywordClass = firstMatch<LengthClass>(text, LENGTH_KEYWORDS);
  const lengthClass =
    hints.lengthClass ??
    phraseClass ??
    keywordClass ??
    (lengthInches != null ? lengthClassFromInches(lengthInches) : null);

  const colors = hints.colors && hints.colors.length > 0 ? hints.colors : extractColors(text);
  const silhouette = hints.silhouette ?? firstMatch(text, SILHOUETTE_KEYWORDS);
  const neckline = hints.neckline ?? firstMatch(text, NECKLINE_KEYWORDS);
  const sleeve = hints.sleeve ?? firstMatch(text, SLEEVE_KEYWORDS);
  const fabric = hints.fabric ?? firstMatch(text, FABRIC_KEYWORDS);
  const explicitPattern = firstMatch(text, PATTERN_KEYWORDS);
  // A colored garment with no pattern word is overwhelmingly a solid.
  const pattern = hints.pattern ?? explicitPattern ?? (colors.length > 0 ? 'solid' : null);
  const occasions =
    hints.occasions && hints.occasions.length > 0
      ? hints.occasions
      : uniqueInOrder(matchOccasions(text));

  const fieldsFound = [
    lengthClass,
    lengthInches,
    silhouette,
    neckline,
    sleeve,
    fabric,
    explicitPattern,
    colors.length > 0 ? 'colors' : null,
    measurements.bust ?? measurements.waist ?? measurements.hip,
  ].filter((f) => f != null).length;
  const confidence = Math.min(MOCK_CONFIDENCE_CAP, 0.1 + 0.05 * fieldsFound);

  const attrs: ExtractedAttributes = {
    lengthClass,
    lengthInches: lengthInches ?? null,
    lengthBasis: lengthInches != null ? 'stated' : null,
    measurements,
    colors,
    fabric,
    neckline,
    silhouette,
    sleeve,
    pattern,
    occasions,
    // TITLE only — descriptions cross-sell "mini me" versions on ADULT dresses
    audience: hints.audience ?? audienceFromText(input.title),
    attributeVector: {},
    confidence,
  };
  attrs.attributeVector =
    hints.attributeVector && Object.keys(hints.attributeVector).length > 0
      ? hints.attributeVector
      : buildAttributeVector(attrs);
  return attrs;
}

/**
 * Color extraction with span blanking: multi-word names win over their
 * single-word substrings ("burnt orange" never double-counts as "orange").
 */
export function extractColors(text: string): ColorTag[] {
  let haystack = text;
  const found: ColorTag[] = [];
  for (const [re, tag] of COLOR_TABLE) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    if (global.test(haystack)) {
      found.push({ ...tag });
      haystack = haystack.replace(global, ' ');
    }
    if (found.length >= 3) break; // dresses rarely list more
  }
  return found;
}

function matchOccasions(text: string): string[] {
  const out: string[] = [];
  for (const [re, occ] of OCCASION_KEYWORDS) if (re.test(text)) out.push(occ);
  return out;
}

function uniqueInOrder<T>(items: T[]): T[] {
  return [...new Set(items)];
}
