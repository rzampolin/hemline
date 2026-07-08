/**
 * Vision length-estimation pass — closes the "Measured inches" gap
 * (docs/ARCHITECTURE.md §5 fallback 1: Haiku image estimate → confidence
 * 'medium'; §7.2 one-image-max economy).
 *
 * Brand sites almost never state HPS-to-hem inches, so ~99% of live listings
 * rank off the length-class prior. This FOCUSED second pass makes one Haiku
 * vision call per listing (the on-model product photo + a grounded prompt) and
 * returns an ESTIMATE — it must flow into matching/UI with
 * lengthBasis='image_estimate' (→ hem confidence 'medium'), never as
 * "Measured".
 *
 * Sanity clamp: estimates are checked against the §5 length-class prior bands
 * (the same inch thresholds as lengthClassFromInches). A "mini" estimated at
 * 55" is distrusted — we keep the class prior (write NO inches) and flag low
 * confidence; the hem then honestly falls back to basis='length_class_prior'.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import type { LengthClass } from '@hemline/contracts';
import { createAiClient, type AiClient } from '../client';

// ── model-facing schema (zod/v4 for zodOutputFormat, decisions-ai-eng #13) ──

export const LengthEstimateOutputSchema = z.object({
  /** HPS/shoulder-to-hem estimate in inches; null when not estimable. */
  lengthInches: z.number().nullable(),
  /** model's self-assessed confidence, 0..1 */
  confidence: z.number(),
  reasoning: z.string().nullable(),
});
export type LengthEstimateOutput = z.infer<typeof LengthEstimateOutputSchema>;

export const LENGTH_ESTIMATION_SYSTEM_PROMPT = `You are Hemline's garment-length estimator. You are shown ONE product photo of a dress plus its title and (when known) its marketing length class. Estimate the garment's length in inches, measured from the high point of the shoulder (HPS) straight down to the hem.

Anchor assumptions:
- Fashion models are typically ~5'9" (175 cm). On such a model, the shoulder line sits ~56-57" above the floor, the knee crease ~19-20" above the floor, mid-calf ~11", the ankle ~3".
- Read where the hem falls on the model's body (mid-thigh, knee, mid-calf, ankle, floor) and convert to HPS-to-hem inches using those landmarks. Example: a hem at the knee on a 5'9" model is roughly 56 - 19 = 37-39".
- If the photo is a flat lay or on a mannequin/hanger, estimate from garment proportions if a scale reference exists; otherwise return lengthInches: null with confidence 0.
- If the photo does not show the full garment (hem cropped out), return lengthInches: null.

Output JSON only: { "lengthInches": number|null, "confidence": 0..1, "reasoning": short string or null }.
- confidence is YOUR self-assessment: 0.8+ only when the full garment is visible on a standing model; 0.5 or lower for partial views, seated poses, or unusual angles.
- This is an ESTIMATE, not a measurement — round to the nearest inch, never fabricate precision.`;

export interface LengthEstimateInput {
  contentHash: string;
  primaryImageUrl: string;
  title: string;
  lengthClass: LengthClass | null;
  /** existing extracted attrs worth grounding on (silhouette etc.) — optional */
  silhouette?: string | null;
}

export interface LengthEstimateResult {
  /**
   * 'estimated'  → lengthInches holds a sane vision estimate (write it with
   *                lengthBasis='image_estimate');
   * 'clamped'    → estimate contradicted the lengthClass prior band — distrust
   *                it, keep the class prior (write NO inches, mark attempted);
   * 'no_estimate'→ model could not estimate (null) — mark attempted;
   * 'failed'     → API/validation error — do NOT mark, safe to retry later.
   */
  status: 'estimated' | 'clamped' | 'no_estimate' | 'failed';
  lengthInches: number | null;
  /** raw model value before clamping, for logging */
  rawLengthInches: number | null;
  modelConfidence: number;
  reasoning: string | null;
  error?: string;
}

/**
 * §5 prior bands per length class — the same inch thresholds the extraction
 * prompt/taxonomy use (midpoints between the canonical reference lengths),
 * widened by CLAMP_TOLERANCE_IN on each side before we distrust an estimate.
 */
export const LENGTH_CLASS_BANDS_IN: Record<LengthClass, { min: number; max: number }> = {
  micro: { min: 20, max: 31.5 },
  mini: { min: 31.5, max: 34.5 },
  above_knee: { min: 34.5, max: 37.5 },
  knee: { min: 37.5, max: 41.5 },
  midi: { min: 41.5, max: 45.5 },
  mid_calf: { min: 45.5, max: 51 },
  maxi: { min: 51, max: 57.5 },
  floor: { min: 57.5, max: 70 },
};

/** Estimates may disagree with the marketing class by this much before we distrust them. */
export const CLAMP_TOLERANCE_IN = 2;

/** Hard plausibility window for any dress regardless of class. */
export const PLAUSIBLE_LENGTH_IN: { min: number; max: number } = { min: 18, max: 70 };

export interface ClampedEstimate {
  lengthInches: number | null;
  clamped: boolean;
}

/**
 * Sanity-clamp a raw vision estimate against the lengthClass prior band.
 * Out-of-band (beyond tolerance) → distrust: return null inches + clamped=true
 * so the caller keeps the class prior and flags low confidence.
 */
export function clampLengthEstimate(
  rawInches: number | null,
  lengthClass: LengthClass | null,
): ClampedEstimate {
  if (rawInches == null || !Number.isFinite(rawInches)) {
    return { lengthInches: null, clamped: false };
  }
  if (rawInches < PLAUSIBLE_LENGTH_IN.min || rawInches > PLAUSIBLE_LENGTH_IN.max) {
    return { lengthInches: null, clamped: true };
  }
  if (lengthClass != null) {
    const band = LENGTH_CLASS_BANDS_IN[lengthClass];
    if (
      rawInches < band.min - CLAMP_TOLERANCE_IN ||
      rawInches > band.max + CLAMP_TOLERANCE_IN
    ) {
      return { lengthInches: null, clamped: true };
    }
  }
  return { lengthInches: Math.round(rawInches * 10) / 10, clamped: false };
}

export function buildLengthEstimationUserText(input: LengthEstimateInput): string {
  const lines = [
    `TITLE: ${input.title}`,
    `MARKETING LENGTH CLASS: ${input.lengthClass ?? 'unknown'}`,
  ];
  if (input.silhouette) lines.push(`SILHOUETTE: ${input.silhouette}`);
  lines.push('Estimate the HPS-to-hem length in inches from the photo.');
  return lines.join('\n');
}

export interface LengthEstimatorStats {
  calls: number;
  estimated: number;
  clamped: number;
  noEstimate: number;
  failed: number;
}

export interface LengthEstimator {
  readonly mode: 'live' | 'mock';
  estimateOne(input: LengthEstimateInput): Promise<LengthEstimateResult>;
  readonly stats: LengthEstimatorStats;
  /** accumulated live spend (USD) on this estimator's cost meter */
  costUsd(): number;
}

export interface LengthEstimatorOptions {
  client?: AiClient;
  maxOutputTokens?: number;
  logger?: (message: string) => void;
}

export function createLengthEstimator(options: LengthEstimatorOptions = {}): LengthEstimator {
  const client = options.client ?? createAiClient();
  const maxOutputTokens = options.maxOutputTokens ?? 300;
  const log = options.logger ?? ((m: string) => console.log(m));
  const stats: LengthEstimatorStats = {
    calls: 0,
    estimated: 0,
    clamped: 0,
    noEstimate: 0,
    failed: 0,
  };

  async function estimateOne(input: LengthEstimateInput): Promise<LengthEstimateResult> {
    if (client.effectiveMode() === 'mock') {
      // No deterministic stand-in exists for vision estimates — report failure
      // (safe to retry once a key/budget is available). The CLI stops the run.
      stats.failed += 1;
      return {
        status: 'failed',
        lengthInches: null,
        rawLengthInches: null,
        modelConfidence: 0,
        reasoning: null,
        error: client.mode === 'mock' ? 'no ANTHROPIC_API_KEY' : 'daily AI budget exhausted',
      };
    }
    const anthropic = client.anthropic!;
    const model = client.models.extraction;
    try {
      const message = await anthropic.messages.create({
        model,
        max_tokens: maxOutputTokens,
        system: [
          {
            type: 'text',
            text: LENGTH_ESTIMATION_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: input.primaryImageUrl } },
              { type: 'text', text: buildLengthEstimationUserText(input) },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(LengthEstimateOutputSchema) },
      });
      stats.calls += 1;
      client.meter.record(model, message.usage);
      const text =
        message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      const parsed = LengthEstimateOutputSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`length-estimate output failed validation`);
      const output = parsed.data;
      const modelConfidence = Math.max(0, Math.min(1, output.confidence));

      if (output.lengthInches == null) {
        stats.noEstimate += 1;
        return {
          status: 'no_estimate',
          lengthInches: null,
          rawLengthInches: null,
          modelConfidence,
          reasoning: output.reasoning,
        };
      }
      const clamped = clampLengthEstimate(output.lengthInches, input.lengthClass);
      if (clamped.clamped) {
        stats.clamped += 1;
        log(
          `[CLAMP] ${input.contentHash.slice(0, 12)}… estimate ${output.lengthInches}" contradicts ` +
            `class '${input.lengthClass ?? 'unknown'}' prior band — keeping class prior (low confidence)`,
        );
        return {
          status: 'clamped',
          lengthInches: null,
          rawLengthInches: output.lengthInches,
          modelConfidence: Math.min(modelConfidence, 0.2),
          reasoning: output.reasoning,
        };
      }
      stats.estimated += 1;
      return {
        status: 'estimated',
        lengthInches: clamped.lengthInches,
        rawLengthInches: output.lengthInches,
        modelConfidence,
        reasoning: output.reasoning,
      };
    } catch (err) {
      stats.failed += 1;
      return {
        status: 'failed',
        lengthInches: null,
        rawLengthInches: null,
        modelConfidence: 0,
        reasoning: null,
        error: (err as Error).message,
      };
    }
  }

  return {
    get mode() {
      return client.effectiveMode();
    },
    estimateOne,
    stats,
    costUsd() {
      return client.meter.totalUsd();
    },
  };
}
