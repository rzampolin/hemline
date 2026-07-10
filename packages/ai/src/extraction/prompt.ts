/**
 * Live extraction prompt + schema — docs/ARCHITECTURE.md §7.2.
 *
 * Stable system prompt (prompt-cached) with the Fashionpedia-derived closed
 * vocabularies; the *schema* enforces the taxonomy (enums), the prompt explains
 * edge cases. Volatile listing content goes in the user turn, after the
 * cached block. The deterministic regex pre-parse is embedded in the user turn
 * as ground truth the model must respect.
 */
// The SDK's zodOutputFormat requires zod/v4 schemas; the frozen contracts are
// authored against zod v3. We define the model-facing schema in v4, deriving
// the enum values from the contracts so the taxonomies cannot drift.
import { z } from 'zod/v4';
import {
  LengthClassSchema,
  SilhouetteSchema,
  type ExtractionInput,
} from '@hemline/contracts';
import type { ParsedMeasurements } from './measurements';
import { AUDIENCES, NECKLINES, OCCASIONS, PATTERNS, SLEEVES } from './taxonomy';

/**
 * What the model is asked to produce. `attributeVector` is intentionally NOT
 * model output — we derive it deterministically (buildAttributeVector) so
 * mock, live, and fixture vectors stay cosine-compatible. Records are also
 * unsupported by strict structured outputs.
 */
export const ExtractionModelOutputSchema = z.object({
  lengthClass: z.enum(LengthClassSchema.options).nullable(),
  lengthInches: z.number().nullable(),
  measurements: z.object({
    bust: z.number().nullable(),
    waist: z.number().nullable(),
    hip: z.number().nullable(),
    length: z.number().nullable(),
  }),
  colors: z.array(
    z.object({ name: z.string(), family: z.string(), hex: z.string().nullable() }),
  ),
  fabric: z.string().nullable(),
  neckline: z.enum(NECKLINES).nullable(),
  silhouette: z.enum(SilhouetteSchema.options).nullable(),
  sleeve: z.enum(SLEEVES).nullable(),
  pattern: z.enum(PATTERNS).nullable(),
  occasions: z.array(z.enum(OCCASIONS)),
  audience: z.enum(AUDIENCES).nullable(),
  confidence: z.number(),
});
export type ExtractionModelOutput = z.infer<typeof ExtractionModelOutputSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `You are Hemline's dress-listing attribute extractor. Given one resale or DTC dress listing (title + description, occasionally one photo), extract structured attributes. Output must satisfy the provided JSON schema; every enum field must use the schema's exact values.

Rules:
- Extract only what the text (or photo, if given) supports. Use null / [] when unknown. Never guess brand-typical attributes.
- lengthInches is the garment length from HPS (high point of shoulder) to hem, in inches.
- Measurement conversions: "pit to pit X" is a FLAT width → bust = 2·X. "waist X flat" → waist = 2·X. A stated "bust 36" (no "flat") is already the full circumference. Convert cm to inches (÷2.54, round to 0.1).
- If a length is stated waist-to-hem (e.g. "waist to hem 24in"), do NOT report it as lengthInches (that field is HPS-basis only); leave lengthInches null and set lengthClass from context.
- lengthClass: prefer an explicitly stated garment reality (e.g. "falls to a mid calf length", stated inches) over a marketing title word ("Midi Dress"). If only inches are known: <31.5 micro, <34.5 mini, <37.5 above_knee, <41.5 knee, <45.5 midi, <51 mid_calf, <57.5 maxi, else floor.
- colors: 1–3 colors, most dominant first; name is the seller's word (lowercase), family one of: black, white, gray, brown, red, orange, yellow, green, blue, purple, pink, metallic; hex a representative sRGB hex or null.
- pattern: "solid" when a color is stated and no print is mentioned.
- audience: who the garment is FOR. "child" when this is a kids'/girls' item — a child model wearing it in the photo is unmistakable; other signals are kid size runs (2T-6T, 4Y, 12M, slash-pair years like 2/3…8/9) or girls/kids/toddler/baby wording. "adult" when it is clearly adult womenswear. null only when genuinely unsure. Adult traps that are NOT child signals: "mini dress" (a length), "baby blue/pink" (colors), "babydoll"/"baby doll" (an adult silhouette), "baby shower" (an adult occasion), "girls night out" (adult party copy), numeric sizes 2-14 alone (a normal adult US run).
- A PRE-PARSED MEASUREMENTS block computed by a deterministic parser may be present in the input. Treat its values as ground truth: copy them into your output unless the listing text plainly contradicts them.
- confidence: 0..1 — your overall confidence in the extraction (1 = every field explicit in the text).`;

export interface BuiltExtractionMessages {
  userText: string;
  /** true when the primary image should be attached (two-pass heuristic). */
  wantsImage: boolean;
}

export function buildExtractionUserText(
  input: ExtractionInput,
  parsed: ParsedMeasurements,
): BuiltExtractionMessages {
  const lines: string[] = [
    `TITLE: ${input.title}`,
    `BRAND: ${input.brand ?? 'unknown'}`,
    `SIZE LABELS: ${input.sizeLabels.join(', ') || 'none'}`,
    `DESCRIPTION: ${input.description ?? '(none)'}`,
  ];
  const preParsed: Record<string, unknown> = {};
  if (parsed.bust !== null) preParsed.bust = parsed.bust;
  if (parsed.waist !== null) preParsed.waist = parsed.waist;
  if (parsed.hip !== null) preParsed.hip = parsed.hip;
  if (parsed.length !== null) {
    preParsed.length = parsed.length;
    preParsed.lengthMeasuredFrom = parsed.lengthMeasuredFrom;
  }
  if (Object.keys(preParsed).length > 0) {
    lines.push(`PRE-PARSED MEASUREMENTS (deterministic, trust these): ${JSON.stringify(preParsed)}`);
  }
  if (input.attributeHints && Object.keys(input.attributeHints).length > 0) {
    lines.push(`SOURCE HINTS (structured data from the marketplace): ${JSON.stringify(input.attributeHints)}`);
  }

  // Doc §7.2 two-pass economy: attach the single primary image only when the
  // text alone would leave the two load-bearing fields unknown.
  const text = `${input.title} ${input.description ?? ''}`;
  const textHasLengthSignal =
    parsed.length !== null || /\b(micro|mini|midi|maxi|knee|gown|floor[-\s]?length|mid[-\s]?calf|short\s+dress)\b/i.test(text);
  const textHasSilhouetteSignal =
    /\b(a[-\s]?line|sheath|wrap|fit[-\s]?(?:and|&|n)[-\s]?flare|skater|slip|shirt[-\s]?dress|shirtdress|bodycon|trapeze|tent|swing|empire|shift|silhouette)\b/i.test(text);
  const wantsImage =
    input.primaryImageUrl !== null && (!textHasLengthSignal || !textHasSilhouetteSignal);

  return { userText: lines.join('\n'), wantsImage };
}
