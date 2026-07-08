/**
 * Attribute/measurement extraction — docs/ARCHITECTURE.md §7.2.
 *
 * - Mock mode (no key / budget cap): deterministic rule engine (mock.ts).
 * - Live mode: Haiku (claude-haiku-4-5-20251001), JSON-schema-constrained via
 *   zodOutputFormat, prompt-cached system block, deterministic measurement
 *   pre-parse embedded in (and verified against) the prompt, at most one image
 *   and only when the text alone is weak (two-pass economy).
 * - Idempotent by content_hash: the cache port mirrors the `extractions`
 *   table semantics. This package has read-only DB access, so persistence is
 *   injected — backend/data-eng wire `ExtractionCacheStore` to the table; the
 *   in-memory default keeps the service self-contained for tests/dev.
 * - Batch-friendly: chunked concurrency for live calls; the Message Batches
 *   API (50% off) for large backfills when EXTRACTION_USE_BATCHES=true.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ExtractedAttributesSchema,
  type ExtractedAttributes,
  type ExtractionInput,
  type ExtractionService,
} from '@hemline/contracts';
import { createAiClient, type AiClient } from '../client';
import { coerceExtractionOutput } from './coerce';
import { measurementsAgree, parseMeasurements, type ParsedMeasurements } from './measurements';
import { mockExtract } from './mock';
import {
  buildExtractionUserText,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionModelOutputSchema,
  type ExtractionModelOutput,
} from './prompt';
import { buildAttributeVector } from './taxonomy';

export interface CachedExtraction {
  attributes: ExtractedAttributes;
  model: string;
}

/**
 * Persistence port mirroring the `extractions` table (content_hash PK).
 * backend-eng implements this over Drizzle; ai never writes the DB directly.
 */
export interface ExtractionCacheStore {
  get(contentHash: string): Promise<CachedExtraction | null>;
  set(contentHash: string, value: CachedExtraction): Promise<void>;
}

export class InMemoryExtractionCache implements ExtractionCacheStore {
  private readonly map = new Map<string, CachedExtraction>();
  async get(contentHash: string): Promise<CachedExtraction | null> {
    return this.map.get(contentHash) ?? null;
  }
  async set(contentHash: string, value: CachedExtraction): Promise<void> {
    this.map.set(contentHash, value);
  }
  get size(): number {
    return this.map.size;
  }
}

/**
 * Per-run counters for the CLI to report (Task: enum-validation fallback fix).
 * All counts are cumulative over the service instance's lifetime.
 */
export interface ExtractionRunStats {
  /** live API calls made (first attempts + retries) */
  liveCalls: number;
  /** first-attempt validation failures that triggered the ONE feedback retry */
  retries: number;
  /** retries whose corrected JSON validated */
  retrySuccesses: number;
  /** outputs recovered by deterministic enum/array coercion */
  coercions: number;
  /** extractions that fell all the way back to the mock rule engine */
  fallbacks: number;
  /** listings served by the deterministic mock engine (keyless / budget cap) */
  mockExtractions: number;
  /** cache hits (no API call) */
  cacheHits: number;
}

/** ExtractionService (frozen contract) + additive run observability. */
export interface ExtractionServiceWithStats extends ExtractionService {
  readonly stats: ExtractionRunStats;
  /** accumulated live spend (USD) recorded on this service's cost meter */
  costUsd(): number;
}

export interface ExtractionServiceOptions {
  client?: AiClient;
  cache?: ExtractionCacheStore;
  /** Live-call chunk size (parallel requests per wave). Default 5. */
  concurrency?: number;
  /**
   * Use the Message Batches API (50% off, results within ~1h) for misses at or
   * above `batchThreshold`. Default: EXTRACTION_USE_BATCHES === 'true' —
   * off by default because extractBatch() then blocks on batch completion,
   * which suits the daily crawl but not interactive runs (doc §7.2 --live).
   */
  useBatchesApi?: boolean;
  batchThreshold?: number;
  batchPollIntervalMs?: number;
  batchMaxWaitMs?: number;
  maxOutputTokens?: number;
  logger?: (message: string) => void;
}

export function createExtractionService(
  options: ExtractionServiceOptions = {},
): ExtractionServiceWithStats {
  const client = options.client ?? createAiClient();
  const cache = options.cache ?? new InMemoryExtractionCache();
  const concurrency = options.concurrency ?? 5;
  const stats: ExtractionRunStats = {
    liveCalls: 0,
    retries: 0,
    retrySuccesses: 0,
    coercions: 0,
    fallbacks: 0,
    mockExtractions: 0,
    cacheHits: 0,
  };
  const useBatchesApi =
    options.useBatchesApi ?? process.env.EXTRACTION_USE_BATCHES === 'true';
  const batchThreshold = options.batchThreshold ?? 20;
  const batchPollIntervalMs = options.batchPollIntervalMs ?? 30_000;
  const batchMaxWaitMs = options.batchMaxWaitMs ?? 60 * 60_000;
  const maxOutputTokens = options.maxOutputTokens ?? 1500;
  const log = options.logger ?? ((m: string) => console.log(m));

  async function extractBatch(
    inputs: ExtractionInput[],
  ): Promise<Map<string, ExtractedAttributes>> {
    const results = new Map<string, ExtractedAttributes>();
    const misses: ExtractionInput[] = [];

    // 1. content-hash cache — idempotent re-runs never call the API (§7.2)
    for (const input of inputs) {
      if (results.has(input.contentHash)) continue;
      const cached = await cache.get(input.contentHash);
      if (cached) {
        stats.cacheHits += 1;
        results.set(input.contentHash, cached.attributes);
      } else {
        misses.push(input);
      }
    }
    if (misses.length === 0) return results;

    const mode = client.effectiveMode();
    if (mode === 'mock') {
      const reason =
        client.mode === 'mock' ? 'no ANTHROPIC_API_KEY' : 'daily AI budget exhausted';
      log(`[MOCK] extraction: ${misses.length} listing(s) via deterministic rule engine (${reason})`);
      for (const input of misses) {
        stats.mockExtractions += 1;
        await settle(input, mockExtract(input), 'mock');
      }
      return results;
    }

    if (useBatchesApi && misses.length >= batchThreshold) {
      await runViaBatchesApi(misses);
      return results;
    }

    // chunked concurrency, budget-checked per wave
    for (let i = 0; i < misses.length; i += concurrency) {
      if (client.effectiveMode() === 'mock') {
        const rest = misses.slice(i);
        log(`[MOCK] extraction: budget cap hit mid-run — ${rest.length} listing(s) fall back to rule engine`);
        for (const input of rest) {
          stats.mockExtractions += 1;
          await settle(input, mockExtract(input), 'mock');
        }
        break;
      }
      const wave = misses.slice(i, i + concurrency);
      await Promise.all(wave.map((input) => extractOneLive(input)));
    }
    return results;

    async function settle(
      input: ExtractionInput,
      attributes: ExtractedAttributes,
      model: string,
    ): Promise<void> {
      results.set(input.contentHash, attributes);
      await cache.set(input.contentHash, { attributes, model });
    }

    /**
     * One live extraction, with the validation recovery ladder:
     *   validate → ONE retry with the Zod errors fed back → deterministic
     *   coercion (coerce.ts) → mock fallback (loud [FALLBACK] log).
     */
    async function extractOneLive(input: ExtractionInput): Promise<void> {
      const anthropic = client.anthropic!;
      const model = client.models.extraction;
      const parsed = parseMeasurements(`${input.title}\n${input.description ?? ''}`);
      const userContent = buildUserContent(input, parsed);
      const baseParams = {
        model,
        max_tokens: maxOutputTokens,
        system: [
          {
            type: 'text' as const,
            text: EXTRACTION_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        output_config: { format: zodOutputFormat(ExtractionModelOutputSchema) },
      };
      try {
        const first = await anthropic.messages.create({
          ...baseParams,
          messages: [{ role: 'user', content: userContent }],
        });
        stats.liveCalls += 1;
        client.meter.record(model, first.usage);
        const firstText = textOf(first);
        let validated = validateModelJson(firstText);

        if (!validated.output) {
          // 1) retry ONCE, feeding the validation errors back to the model
          stats.retries += 1;
          const second = await anthropic.messages.create({
            ...baseParams,
            messages: [
              { role: 'user', content: userContent },
              { role: 'assistant', content: firstText || '(no output)' },
              {
                role: 'user',
                content:
                  `Your previous JSON failed schema validation:\n${validated.errors}\n` +
                  `Return the corrected JSON only. Every enum field must use one of the schema's exact values; ` +
                  `use null (or omit the array item) for anything you cannot map onto the allowed values.`,
              },
            ],
          });
          stats.liveCalls += 1;
          client.meter.record(model, second.usage);
          const secondText = textOf(second);
          const retried = validateModelJson(secondText);
          if (retried.output) {
            stats.retrySuccesses += 1;
            validated = retried;
          } else {
            // 2) deterministic coercion of the best available raw payload
            const rawJson = tryJson(secondText) ?? tryJson(firstText);
            const coerced =
              rawJson === undefined
                ? null
                : ExtractionModelOutputSchema.safeParse(coerceExtractionOutput(rawJson));
            if (coerced?.success) {
              stats.coercions += 1;
              validated = { output: coerced.data, errors: '' };
            } else {
              throw new Error(`schema validation failed after retry + coercion: ${retried.errors}`);
            }
          }
        }
        await settle(input, finalizeModelOutput(validated.output!, parsed, input), model);
      } catch (err) {
        // 3) last resort — loud, with the full content hash for triage
        stats.fallbacks += 1;
        stats.mockExtractions += 1;
        log(
          `[FALLBACK] extraction ${input.contentHash} → mock rule engine: ${(err as Error).message}`,
        );
        await settle(input, mockExtract(input), 'mock');
      }
    }

    async function runViaBatchesApi(batchInputs: ExtractionInput[]): Promise<void> {
      const anthropic = client.anthropic!;
      const model = client.models.extraction;
      const parsedByHash = new Map<string, ParsedMeasurements>();
      const inputByHash = new Map<string, ExtractionInput>();

      const requests = batchInputs.map((input) => {
        const parsed = parseMeasurements(`${input.title}\n${input.description ?? ''}`);
        parsedByHash.set(input.contentHash, parsed);
        inputByHash.set(input.contentHash, input);
        return {
          custom_id: customIdFor(input.contentHash),
          params: {
            model,
            max_tokens: maxOutputTokens,
            system: [
              {
                type: 'text' as const,
                text: EXTRACTION_SYSTEM_PROMPT,
                cache_control: { type: 'ephemeral' as const },
              },
            ],
            messages: [
              { role: 'user' as const, content: buildUserContent(input, parsed) },
            ],
            output_config: { format: zodOutputFormat(ExtractionModelOutputSchema) },
          },
        };
      });
      const hashByCustomId = new Map(
        batchInputs.map((i) => [customIdFor(i.contentHash), i.contentHash]),
      );

      log(`extraction: submitting ${requests.length} request(s) via Message Batches API`);
      const batch = await anthropic.messages.batches.create({ requests });

      const deadline = Date.now() + batchMaxWaitMs;
      let status = batch;
      while (status.processing_status !== 'ended') {
        if (Date.now() > deadline) {
          log(`[MOCK] extraction: batch ${batch.id} timed out — falling back to rule engine`);
          for (const input of batchInputs) {
            if (!results.has(input.contentHash)) {
              await settle(input, mockExtract(input), 'mock');
            }
          }
          return;
        }
        await sleep(batchPollIntervalMs);
        status = await anthropic.messages.batches.retrieve(batch.id);
      }

      for await (const entry of await anthropic.messages.batches.results(batch.id)) {
        const contentHash = hashByCustomId.get(entry.custom_id);
        if (!contentHash) continue;
        const input = inputByHash.get(contentHash)!;
        const parsed = parsedByHash.get(contentHash)!;
        if (entry.result.type === 'succeeded') {
          try {
            const msg = entry.result.message;
            stats.liveCalls += 1;
            client.meter.record(model, msg.usage, { batch: true });
            const text = textOf(msg);
            let validated = validateModelJson(text);
            if (!validated.output) {
              // batches can't do a feedback retry — go straight to coercion
              const rawJson = tryJson(text);
              const coerced =
                rawJson === undefined
                  ? null
                  : ExtractionModelOutputSchema.safeParse(coerceExtractionOutput(rawJson));
              if (!coerced?.success) {
                throw new Error(`batch entry failed validation + coercion: ${validated.errors}`);
              }
              stats.coercions += 1;
              validated = { output: coerced.data, errors: '' };
            }
            await settle(input, finalizeModelOutput(validated.output!, parsed, input), model);
            continue;
          } catch (err) {
            stats.fallbacks += 1;
            log(`[FALLBACK] extraction ${contentHash} → mock rule engine: ${(err as Error).message}`);
            // fall through to mock
          }
        }
        stats.mockExtractions += 1;
        await settle(input, mockExtract(input), 'mock');
      }
      // anything the batch never returned (expired/canceled) → mock
      for (const input of batchInputs) {
        if (!results.has(input.contentHash)) {
          stats.mockExtractions += 1;
          await settle(input, mockExtract(input), 'mock');
        }
      }
    }
  }

  return {
    get mode() {
      return client.effectiveMode();
    },
    extractBatch,
    stats,
    costUsd() {
      return client.meter.totalUsd();
    },
  };
}

/** First text block of a message, or '' (structured outputs emit one text block). */
function textOf(message: Anthropic.Message): string {
  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  return block?.text ?? '';
}

/** JSON.parse that signals "unparseable" with undefined (null is a valid JSON value). */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function validateModelJson(text: string): {
  output: ExtractionModelOutput | null;
  errors: string;
} {
  const raw = tryJson(text);
  if (raw === undefined) return { output: null, errors: 'response was not valid JSON' };
  const result = ExtractionModelOutputSchema.safeParse(raw);
  if (result.success) return { output: result.data, errors: '' };
  const errors = result.error.issues
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  return { output: null, errors };
}

function buildUserContent(
  input: ExtractionInput,
  parsed: ParsedMeasurements,
): Anthropic.ContentBlockParam[] {
  const { userText, wantsImage } = buildExtractionUserText(input, parsed);
  const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: userText }];
  if (wantsImage && input.primaryImageUrl) {
    content.push({
      type: 'image',
      source: { type: 'url', url: input.primaryImageUrl },
    });
  }
  return content;
}

/**
 * Model output → contract shape, with the deterministic pre-parse enforced:
 * where the regex parser found a value and the model disagrees by more than
 * 1.5″, the deterministic value wins (doc: "passed to and verified against").
 */
export function finalizeModelOutput(
  output: ExtractionModelOutput,
  parsed: ParsedMeasurements,
  input: ExtractionInput,
): ExtractedAttributes {
  const measurements = { ...output.measurements };
  for (const field of ['bust', 'waist', 'hip'] as const) {
    const det = parsed[field];
    if (det !== null && !measurementsAgree(det, measurements[field])) {
      measurements[field] = det;
    }
    if (det !== null && measurements[field] === null) measurements[field] = det;
  }
  let lengthInches = output.lengthInches;
  if (parsed.length !== null && parsed.lengthMeasuredFrom === 'hps') {
    if (lengthInches === null || !measurementsAgree(parsed.length, lengthInches)) {
      lengthInches = parsed.length;
    }
    if (measurements.length === null) measurements.length = parsed.length;
  }

  const attrs: ExtractedAttributes = {
    lengthClass: output.lengthClass,
    lengthInches,
    // Text-pass lengths are always seller-stated; the vision pass (lengths/)
    // writes 'image_estimate' when it later fills a missing length.
    lengthBasis: lengthInches != null ? 'stated' : null,
    measurements,
    colors: output.colors,
    fabric: output.fabric,
    neckline: output.neckline,
    silhouette: output.silhouette,
    sleeve: output.sleeve,
    pattern: output.pattern,
    occasions: output.occasions,
    attributeVector: {},
    confidence: Math.max(0, Math.min(1, output.confidence)),
  };
  attrs.attributeVector = buildAttributeVector(attrs, {
    isVintage: /\b(vintage|vtg)\b/i.test(input.title),
  });
  // Belt-and-braces: never hand a contract-invalid object downstream.
  return ExtractedAttributesSchema.parse(attrs);
}

function customIdFor(contentHash: string): string {
  // Batch custom_id: 1–64 chars of [a-zA-Z0-9_-]; sha256 hex fits, but guard
  // against non-hash ids in tests/dev.
  const safe = contentHash.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.slice(0, 64) || 'x';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { mockExtract, MOCK_CONFIDENCE_CAP, extractColors } from './mock';
export { coerceExtractionOutput } from './coerce';
export {
  parseMeasurements,
  measurementsAgree,
  type ParsedMeasurements,
} from './measurements';
export {
  parseModelInfo,
  MODEL_HEIGHT_RANGE_IN,
  type ParsedModelInfo,
} from './model-height';
export {
  buildAttributeVector,
  lengthClassFromInches,
  NECKLINES,
  SLEEVES,
  PATTERNS,
  OCCASIONS,
} from './taxonomy';
export {
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionModelOutputSchema,
  buildExtractionUserText,
  type ExtractionModelOutput,
} from './prompt';
