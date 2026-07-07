/**
 * Color analysis — docs/ARCHITECTURE.md §7.4. Privacy-first & grounded:
 *
 * 1. Selfie buffer → deterministic pixel sampling (sharp, in-memory) →
 *    MeasuredColors. The buffer is processed and discarded — never persisted,
 *    never sent to the model.
 * 2. Live: Sonnet classifies the 12-season FROM THE MEASURED LAB NUMBERS ONLY
 *    (schema-constrained; the prompt carries the same decision rubric as the
 *    deterministic classifier — no raw-image vibes).
 * 3. Keyless / over-budget: deterministic rule-table classification.
 * 4. Manual quiz fallback: pure scoring table, no LLM ever.
 *
 * Palette/avoid lists always come from the curated season tables so the UI is
 * consistent across live, mock, and quiz paths.
 */
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ColorSeasonSchema,
  type ColorAnalysisResult,
  type ColorSeason,
  type MeasuredColors,
  type QuizAnswers,
} from '@hemline/contracts';
import { createAiClient, type AiClient } from '../client';
import { sampleSelfie, type SampleSelfieOptions } from './sampling';
import {
  axesFromMeasured,
  axesFromQuiz,
  caveatFor,
  confidenceFromAxes,
  seasonFromAxes,
  SEASON_DATA,
  syntheticMeasuredFromAxes,
} from './seasons';

export interface AnalyzeSelfieOptions extends SampleSelfieOptions {
  client?: AiClient;
  logger?: (message: string) => void;
}

/**
 * Full selfie pipeline. The `imageBuffer` is sampled in-memory and discarded;
 * only derived numbers leave this function.
 */
export async function analyzeSelfie(
  imageBuffer: Buffer,
  options: AnalyzeSelfieOptions = {},
): Promise<ColorAnalysisResult> {
  const measured = await sampleSelfie(imageBuffer, options);
  const client = options.client ?? createAiClient();
  const log = options.logger ?? ((m: string) => console.log(m));

  if (client.effectiveMode() === 'mock') {
    log('[MOCK] color analysis: deterministic season rule table (no ANTHROPIC_API_KEY or budget cap)');
    return classifyFromMeasured(measured);
  }
  try {
    return await classifyWithSonnet(measured, client);
  } catch (err) {
    log(`[MOCK] color analysis fallback (deterministic): ${(err as Error).message}`);
    return classifyFromMeasured(measured);
  }
}

/** Deterministic classification from measured values (keyless path, §7.5). */
export function classifyFromMeasured(measured: MeasuredColors): ColorAnalysisResult {
  const axes = axesFromMeasured(measured);
  const season = seasonFromAxes(axes);
  const confidence = confidenceFromAxes(axes, measured.sampleQuality);
  return buildResult({
    season,
    confidence,
    explanation: explainAxes(measured, season),
    measured,
    caveat: caveatFor(measured),
    source: 'selfie',
  });
}

/** Manual quiz fallback — pure function, no LLM (doc §7.4 step 4). */
export function classifyFromQuiz(answers: QuizAnswers): ColorAnalysisResult {
  const axes = axesFromQuiz(answers);
  const season = seasonFromAxes(axes);
  const measured = syntheticMeasuredFromAxes(axes);
  return buildResult({
    season,
    confidence: confidenceFromAxes(axes, 'good'),
    explanation:
      `Your quiz answers point to ${prettySeason(season)}: ` +
      `${axes.warmth > 0.15 ? 'warm' : axes.warmth < -0.15 ? 'cool' : 'neutral'} undertones, ` +
      `${axes.depth >= 62 ? 'light' : axes.depth <= 32 ? 'deep' : 'medium'} overall coloring, and ` +
      `${axes.chroma >= 0.55 ? 'bright' : axes.chroma <= 0.3 ? 'soft, muted' : 'balanced'} natural contrast.`,
    measured,
    caveat: null,
    // Contract-approved additive label: quiz results carry SYNTHESIZED
    // measured values (no selfie was sampled) — decisions-ai-eng.md #15.
    source: 'quiz',
  });
}

// ── live path: Sonnet, grounded on measured values only ────────────────────

const SonnetOutputSchema = z.object({
  season: z.enum(ColorSeasonSchema.options),
  confidence: z.number(),
  explanation: z.string(),
});

const COLOR_SYSTEM_PROMPT = `You are Hemline's 12-season color analyst. You receive ONLY numeric measurements sampled from a selfie (CIE Lab values for skin and hair, optionally eyes, plus derived contrast/warmth/chroma scalars). You never see the photo. Classify the person's color season from the numbers alone.

Decision rubric (apply in order):
1. Depth (value): weightedDepth = 0.6·skin.L + 0.4·hair.L. weightedDepth ≤ 32 → dark seasons (dark_autumn if warm, dark_winter otherwise). weightedDepth ≥ 62 → light seasons (light_spring if warm, light_summer otherwise).
2. Warmth: warmth > 0.15 → warm (spring/autumn family); warmth < −0.15 → cool (summer/winter family); otherwise neutral — lean on chroma/contrast and say so in the explanation.
3. Clarity: chroma ≥ 0.55 or contrast ≥ 0.65 → bright seasons (bright_spring if warm, bright_winter otherwise). chroma ≤ 0.30 → soft seasons (soft_autumn if warm, soft_summer otherwise).
4. Otherwise "true" seasons: warm → true_spring when weightedDepth < 48, else true_autumn; cool → true_winter when contrast ≥ 0.45, else true_summer.

Rules:
- Ground every claim in the provided numbers ("your skin b* of 18 leans warm"), never in imagined appearance.
- confidence 0..1; reduce it when warmth is in the neutral band, sampleQuality is 'poor', or skin L* < 35 (undertone measurement is less reliable for deep skin).
- explanation: 2–3 sentences, addressed to the user, plain language.`;

async function classifyWithSonnet(
  measured: MeasuredColors,
  client: AiClient,
): Promise<ColorAnalysisResult> {
  const anthropic = client.anthropic!;
  const model = client.models.color;
  const message = await anthropic.messages.parse({
    model,
    max_tokens: 800,
    system: [
      { type: 'text', text: COLOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `MEASURED VALUES (the only ground truth):\n${JSON.stringify(measured, null, 2)}`,
      },
    ],
    output_config: { format: zodOutputFormat(SonnetOutputSchema) },
  });
  client.meter.record(model, message.usage);
  const output = message.parsed_output;
  if (!output) throw new Error('no parsed_output in response');
  return buildResult({
    season: output.season,
    confidence: Math.max(0, Math.min(1, output.confidence)),
    explanation: output.explanation,
    measured,
    caveat: caveatFor(measured),
    source: 'selfie',
  });
}

// ── shared result assembly ──────────────────────────────────────────────────

function buildResult(args: {
  season: ColorSeason;
  confidence: number;
  explanation: string;
  measured: MeasuredColors;
  caveat: string | null;
  source: 'selfie' | 'quiz';
}): ColorAnalysisResult {
  const data = SEASON_DATA[args.season];
  return {
    season: args.season,
    confidence: args.confidence,
    palette: data.palette,
    avoid: data.avoid,
    explanation: args.explanation,
    measured: args.measured,
    caveat: args.caveat,
    source: args.source,
  };
}

function explainAxes(measured: MeasuredColors, season: ColorSeason): string {
  const warmthWord =
    measured.warmth > 0.15 ? 'warm' : measured.warmth < -0.15 ? 'cool' : 'neutral';
  const depth = 0.6 * measured.skin.L + 0.4 * measured.hair.L;
  const depthWord = depth >= 62 ? 'light' : depth <= 32 ? 'deep' : 'medium-depth';
  const chromaWord =
    measured.chroma >= 0.55 ? 'bright' : measured.chroma <= 0.3 ? 'soft, muted' : 'balanced';
  return (
    `Your measurements read as ${prettySeason(season)}: skin b* of ${measured.skin.b} leans ${warmthWord}, ` +
    `your overall coloring is ${depthWord} (weighted L* ${Math.round(depth)}), and ` +
    `hair–skin contrast of ${measured.contrast} with ${chromaWord} chroma (${measured.chroma}) sets the season's clarity.`
  );
}

function prettySeason(season: ColorSeason): string {
  return season.replace(/_/g, ' ');
}

export { sampleSelfie, srgbToLab, labChroma, type SampleSelfieOptions } from './sampling';
export {
  SEASON_DATA,
  seasonFromAxes,
  axesFromMeasured,
  axesFromQuiz,
  confidenceFromAxes,
  caveatFor,
  type SeasonAxes,
} from './seasons';
