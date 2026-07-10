/**
 * Vision audience recheck — kids-in-catalog founder bug (2026-07-09).
 *
 * One cheap Haiku image call per SUSPECT listing asking exactly one question:
 * is this dress modeled/made for an adult or a child? Used by the purge
 * script's `--recheck-vision` mode for listings that the layer-1 text/size
 * heuristics cannot decide (e.g. Dôen's kids line: adult-reading metadata,
 * sizes 2–10 that look like a normal US run — but a child model in the photo,
 * which is unmistakable visually).
 *
 * Follows the lengths/ vision-pass pattern: base64 image delivery via OUR
 * polite fetcher (the API never fetches URLs — decisions #25), zod-constrained
 * structured output, cost metered on the shared AiClient meter. A failed image
 * download is TERMINAL for that listing ('image_unavailable' — the image IS
 * the input); transient API errors are 'failed' (safe to retry).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import { createAiClient, type AiClient } from '../client';
import { base64ImageBlock, createImageFetcher, type ImageFetcher } from '../images/fetcher';

export const AudienceCheckOutputSchema = z.object({
  /** 'child' when the garment is a kids item; null when genuinely undecidable */
  audience: z.enum(['adult', 'child']).nullable(),
  /** model's self-assessed confidence, 0..1 */
  confidence: z.number(),
});
export type AudienceCheckOutput = z.infer<typeof AudienceCheckOutputSchema>;

export const AUDIENCE_CHECK_SYSTEM_PROMPT = `You are Hemline's audience classifier. You are shown ONE product photo of a dress plus its title and size labels. Answer exactly one question: is this dress FOR AN ADULT WOMAN or FOR A CHILD?

- A child model wearing the dress is decisive: audience "child".
- An adult model wearing it is decisive: audience "adult".
- Flat lays / mannequins: use garment proportions and the size labels. Kid size runs look like 2T-6T, 4Y, 12M, or slash-pair years (2/3, 4/5, 7/8). Plain numerics 0-16 are a NORMAL ADULT US run — not a child signal by themselves.
- Adult styles that are NOT child signals: "mini" (a length), "babydoll"/"baby doll" (an adult silhouette), "baby blue/pink" (colors), "girls night" copy.
- Return null audience ONLY when the photo and labels genuinely cannot decide.

Output JSON only: { "audience": "adult"|"child"|null, "confidence": 0..1 }.`;

export interface AudienceCheckInput {
  contentHash: string;
  primaryImageUrl: string;
  title: string;
  sizeLabels: string[];
}

export interface AudienceCheckResult {
  /**
   * 'classified' → audience holds the verdict (may still be null = undecided);
   * 'image_unavailable' → the photo could not be delivered — TERMINAL for this
   *   listing (the image is the input; no text fallback exists);
   * 'failed' → transient API/validation error, safe to retry later.
   */
  status: 'classified' | 'image_unavailable' | 'failed';
  audience: 'adult' | 'child' | null;
  modelConfidence: number;
  error?: string;
}

export interface AudienceCheckerStats {
  calls: number;
  child: number;
  adult: number;
  undecided: number;
  imageUnavailable: number;
  failed: number;
}

export interface AudienceChecker {
  readonly mode: 'live' | 'mock';
  checkOne(input: AudienceCheckInput): Promise<AudienceCheckResult>;
  readonly stats: AudienceCheckerStats;
  /** accumulated live spend (USD) on this checker's cost meter */
  costUsd(): number;
}

export interface AudienceCheckerOptions {
  client?: AiClient;
  maxOutputTokens?: number;
  /** injectable image fetcher (tests); default: a polite base64 fetcher */
  imageFetcher?: ImageFetcher;
  logger?: (message: string) => void;
}

export function buildAudienceCheckUserText(input: AudienceCheckInput): string {
  return [
    `TITLE: ${input.title}`,
    `SIZE LABELS: ${input.sizeLabels.join(', ') || 'none'}`,
    'Is this dress for an adult woman or for a child?',
  ].join('\n');
}

export function createAudienceChecker(options: AudienceCheckerOptions = {}): AudienceChecker {
  const client = options.client ?? createAiClient();
  const maxOutputTokens = options.maxOutputTokens ?? 100;
  const imageFetcher = options.imageFetcher ?? createImageFetcher();
  const log = options.logger ?? ((m: string) => console.log(m));
  const stats: AudienceCheckerStats = {
    calls: 0,
    child: 0,
    adult: 0,
    undecided: 0,
    imageUnavailable: 0,
    failed: 0,
  };

  async function checkOne(input: AudienceCheckInput): Promise<AudienceCheckResult> {
    if (client.effectiveMode() === 'mock') {
      // No deterministic stand-in for a vision verdict — report failure so the
      // CLI stops instead of writing garbage (same policy as lengths/).
      stats.failed += 1;
      return {
        status: 'failed',
        audience: null,
        modelConfidence: 0,
        error: client.mode === 'mock' ? 'no ANTHROPIC_API_KEY' : 'daily AI budget exhausted',
      };
    }
    const anthropic = client.anthropic!;
    const model = client.models.extraction;
    try {
      const fetched = await imageFetcher.fetchImage(input.primaryImageUrl);
      if (!fetched.ok) {
        stats.imageUnavailable += 1;
        log(
          `[IMAGE-DOWNLOAD] audience ${input.contentHash.slice(0, 12)}… could not download ` +
            `${input.primaryImageUrl} (${fetched.reason}: ${fetched.detail}) — no vision verdict possible`,
        );
        return {
          status: 'image_unavailable',
          audience: null,
          modelConfidence: 0,
          error: `image download failed (${fetched.reason}): ${fetched.detail}`,
        };
      }
      const message: Anthropic.Message = await anthropic.messages.create({
        model,
        max_tokens: maxOutputTokens,
        system: [
          {
            type: 'text',
            text: AUDIENCE_CHECK_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              base64ImageBlock(fetched.image),
              { type: 'text', text: buildAudienceCheckUserText(input) },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(AudienceCheckOutputSchema) },
      });
      stats.calls += 1;
      client.meter.record(model, message.usage);
      const text =
        message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      const parsed = AudienceCheckOutputSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error('audience-check output failed validation');
      const audience = parsed.data.audience;
      if (audience === 'child') stats.child += 1;
      else if (audience === 'adult') stats.adult += 1;
      else stats.undecided += 1;
      return {
        status: 'classified',
        audience,
        modelConfidence: Math.max(0, Math.min(1, parsed.data.confidence)),
      };
    } catch (err) {
      stats.failed += 1;
      return {
        status: 'failed',
        audience: null,
        modelConfidence: 0,
        error: (err as Error).message,
      };
    }
  }

  return {
    get mode() {
      return client.effectiveMode();
    },
    checkOne,
    stats,
    costUsd() {
      return client.meter.totalUsd();
    },
  };
}
