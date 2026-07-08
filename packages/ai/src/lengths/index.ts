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
 *
 * v2 anchoring: when the listing STATES the model's height ("Model is 5'10"
 * and wears a size S" — parsed by extraction/model-height.ts), the prompt
 * anchors on that height with linearly scaled body landmarks instead of the
 * assumed 5'9" default, and the result records which anchor was used
 * (LengthEstimateResult.anchor / anchorHeightInches).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import type { LengthClass } from '@hemline/contracts';
import { createAiClient, isImageUrlDownloadError, type AiClient } from '../client';

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
- Some listings state the model's actual height. When the user message includes a "MODEL HEIGHT (stated on the listing)" line, anchor on THAT height and the body landmarks provided with it instead of the defaults above.
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
  /**
   * Stated model height parsed from listing text (parseModelInfo), inches.
   * When present the prompt anchors on THIS height with proportionally scaled
   * landmarks instead of the assumed 5'9" default.
   */
  statedModelHeightInches?: number | null;
  /** size the model wears, stated on the listing — prompt context only */
  modelSizeWorn?: string | null;
}

/** Which model-height anchor grounded a vision estimate. */
export type LengthAnchor = 'stated_model_height' | 'assumed_default';

/** The v1 anchor: an assumed ~5'9" (69") fashion model. */
export const DEFAULT_MODEL_HEIGHT_IN = 69;

/**
 * Floor-relative body landmarks (inches) at the default 69" anchor — the same
 * numbers the system prompt states (midpoints of its ranges). Scaled linearly
 * for stated model heights.
 */
export const DEFAULT_LANDMARKS_IN = {
  shoulder: 56.5,
  knee: 19.5,
  midCalf: 11,
  ankle: 3,
} as const;

export interface BodyLandmarksIn {
  shoulder: number;
  knee: number;
  midCalf: number;
  ankle: number;
}

/** Linearly scale the default-anchor landmarks to a stated model height. */
export function scaleLandmarks(heightInches: number): BodyLandmarksIn {
  const scale = heightInches / DEFAULT_MODEL_HEIGHT_IN;
  const s = (v: number) => Math.round(v * scale * 10) / 10;
  return {
    shoulder: s(DEFAULT_LANDMARKS_IN.shoulder),
    knee: s(DEFAULT_LANDMARKS_IN.knee),
    midCalf: s(DEFAULT_LANDMARKS_IN.midCalf),
    ankle: s(DEFAULT_LANDMARKS_IN.ankle),
  };
}

/** 70 → `5'10"`, 68.9 → `5'8.9"` — for prompt/report readability. */
export function formatFeetInches(heightInches: number): string {
  const feet = Math.floor(heightInches / 12);
  const inches = Math.round((heightInches - feet * 12) * 10) / 10;
  return `${feet}'${inches}"`;
}

export interface LengthEstimateResult {
  /**
   * 'estimated'  → lengthInches holds a sane vision estimate (write it with
   *                lengthBasis='image_estimate');
   * 'clamped'    → estimate contradicted the lengthClass prior band — distrust
   *                it, keep the class prior (write NO inches, mark attempted);
   * 'no_estimate'→ model could not estimate (null) — mark attempted;
   * 'image_unavailable' → the API itself cannot download the image URL (400
   *                "Unable to download the file…", persisted across the retry
   *                budget). The image IS the input here — no text fallback
   *                exists — so this is TERMINAL: mark 'not_estimable' so the
   *                queue drains instead of re-billing a dead URL forever
   *                (decisions-ai-eng #23);
   * 'failed'     → transient API/validation error — do NOT mark, safe to
   *                retry later.
   */
  status: 'estimated' | 'clamped' | 'no_estimate' | 'image_unavailable' | 'failed';
  lengthInches: number | null;
  /** raw model value before clamping, for logging */
  rawLengthInches: number | null;
  modelConfidence: number;
  reasoning: string | null;
  /** which model-height anchor grounded (or would ground) this call */
  anchor: LengthAnchor;
  /** the anchor height in inches (69 for the assumed default) */
  anchorHeightInches: number;
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
  if (input.statedModelHeightInches != null) {
    const h = input.statedModelHeightInches;
    const lm = scaleLandmarks(h);
    lines.push(
      `MODEL HEIGHT (stated on the listing): ${h}" (${formatFeetInches(h)}). ` +
        `Anchor on THIS height — on this model the shoulder line sits ~${lm.shoulder}" above the floor, ` +
        `the knee ~${lm.knee}", mid-calf ~${lm.midCalf}", the ankle ~${lm.ankle}".`,
    );
    if (input.modelSizeWorn) lines.push(`MODEL WEARS SIZE: ${input.modelSizeWorn}`);
  }
  lines.push('Estimate the HPS-to-hem length in inches from the photo.');
  return lines.join('\n');
}

export interface LengthEstimatorStats {
  calls: number;
  estimated: number;
  clamped: number;
  noEstimate: number;
  /** terminal image-download failures (marked not_estimable by the runner) */
  imageUnavailable: number;
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
  /**
   * Total attempts when the API reports it cannot download the image URL
   * (default 2 — one retry absorbs transient CDN blips; after that the URL is
   * treated as dead and the row surfaces as 'image_unavailable', terminal).
   */
  imageDownloadAttempts?: number;
  logger?: (message: string) => void;
}

export function createLengthEstimator(options: LengthEstimatorOptions = {}): LengthEstimator {
  const client = options.client ?? createAiClient();
  const maxOutputTokens = options.maxOutputTokens ?? 300;
  const imageDownloadAttempts = Math.max(1, options.imageDownloadAttempts ?? 2);
  const log = options.logger ?? ((m: string) => console.log(m));
  const stats: LengthEstimatorStats = {
    calls: 0,
    estimated: 0,
    clamped: 0,
    noEstimate: 0,
    imageUnavailable: 0,
    failed: 0,
  };

  async function estimateOne(input: LengthEstimateInput): Promise<LengthEstimateResult> {
    const anchor: LengthAnchor =
      input.statedModelHeightInches != null ? 'stated_model_height' : 'assumed_default';
    const anchorHeightInches = input.statedModelHeightInches ?? DEFAULT_MODEL_HEIGHT_IN;
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
        anchor,
        anchorHeightInches,
        error: client.mode === 'mock' ? 'no ANTHROPIC_API_KEY' : 'daily AI budget exhausted',
      };
    }
    const anthropic = client.anthropic!;
    const model = client.models.extraction;
    try {
      let message: Anthropic.Message | undefined;
      // The image IS the input for this pass — an API-side image-download
      // failure cannot be worked around, only retried (transient CDN blip)
      // and then surfaced as terminal so the queue drains (decisions #23).
      for (let attempt = 1; message === undefined; attempt++) {
        try {
          message = await anthropic.messages.create({
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
        } catch (err) {
          if (!isImageUrlDownloadError(err)) throw err;
          if (attempt >= imageDownloadAttempts) {
            stats.imageUnavailable += 1;
            log(
              `[IMAGE-URL] lengths ${input.contentHash.slice(0, 12)}… API could not download ` +
                `${input.primaryImageUrl} (${attempt} attempt(s)) — no vision estimate possible, ` +
                `terminal: mark not_estimable`,
            );
            return {
              status: 'image_unavailable',
              lengthInches: null,
              rawLengthInches: null,
              modelConfidence: 0,
              reasoning: null,
              anchor,
              anchorHeightInches,
              error: (err as Error).message,
            };
          }
        }
      }
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
          anchor,
          anchorHeightInches,
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
          anchor,
          anchorHeightInches,
        };
      }
      stats.estimated += 1;
      return {
        status: 'estimated',
        lengthInches: clamped.lengthInches,
        rawLengthInches: output.lengthInches,
        modelConfidence,
        reasoning: output.reasoning,
        anchor,
        anchorHeightInches,
      };
    } catch (err) {
      stats.failed += 1;
      return {
        status: 'failed',
        lengthInches: null,
        rawLengthInches: null,
        modelConfidence: 0,
        reasoning: null,
        anchor,
        anchorHeightInches,
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
