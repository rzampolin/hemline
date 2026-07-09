/**
 * Stage 3 of hybrid free-text search: schema-constrained Haiku query parsing
 * (docs/decisions-search.md), following the extraction-service pattern
 * (zodOutputFormat structured output, keyless/over-budget → skipped, cost
 * metered on the shared client).
 *
 * Design rules encoded in the schema + prompt:
 * - `hard` may only carry things the user EXPLICITLY constrained
 *   (price / size / length class / brand).
 * - vibe / mood / season language ("summer", "cottagecore", "elegant") must
 *   NEVER hard-filter — it goes to `soft` signals and `vibeText`, which feed
 *   ranking + the semantic query embedding.
 *
 * Caching is GLOBAL (query parses are user-independent: "summer formal"
 * parses once, ever): keyed by sha256 of the normalized query, long TTL.
 * Failures negative-cache briefly. A hard client-side timeout (~2.5s) bounds
 * the request path; stage 1 has always already run, so a miss/timeout just
 * means "no enrichment".
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LengthClassSchema, SilhouetteSchema } from '@hemline/contracts';
import { createAiClient, type AiClient } from '../client';
import { OCCASIONS } from '../extraction/taxonomy';
import { COLOR_FAMILIES } from './parse';

/** Global parse cache TTL — parses are user-independent and queries repeat. */
export const QUERY_PARSE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Negative-cache TTL for failures (timeout/API error/validation). */
export const QUERY_PARSE_FAILURE_TTL_MS = 5 * 60_000;
/** Hard client-side deadline — search must never wait longer for enrichment. */
export const QUERY_PARSE_TIMEOUT_MS = 2_500;
/** Output is tiny (a handful of enums + one sentence); 2× worst case. */
export const QUERY_PARSE_MAX_OUTPUT_TOKENS = 600;

export const LlmQueryParseSchema = z.object({
  hard: z.object({
    priceMinCents: z.number().int().nonnegative().nullable(),
    priceMaxCents: z.number().int().nonnegative().nullable(),
    sizesNormalized: z.array(z.number()).nullable(),
    lengthClasses: z.array(z.enum(LengthClassSchema.options)).nullable(),
    brands: z.array(z.string()).nullable(),
  }),
  soft: z.object({
    occasions: z.array(z.enum(OCCASIONS)).nullable(),
    colorFamilies: z.array(z.enum(COLOR_FAMILIES as [string, ...string[]])).nullable(),
    fabrics: z.array(z.string()).nullable(),
    silhouettes: z.array(z.enum(SilhouetteSchema.options)).nullable(),
    /** mood/season/style language for the semantic embedding, or null */
    vibeText: z.string().nullable(),
  }),
});
export type LlmQueryParse = z.infer<typeof LlmQueryParseSchema>;

export const QUERY_PARSE_SYSTEM_PROMPT = `You are Hemline's dress-search query parser. Given one free-text shopping query, split it into hard constraints and soft preferences. Output must satisfy the provided JSON schema; every enum field must use the schema's exact values.

Rules:
- "hard" is ONLY for things the shopper explicitly constrained: a price bound ("under $150" → priceMaxCents 15000), a numeric size ("size 8" → sizesNormalized [8]), a garment length word (mini/midi/maxi/knee-length/gown → lengthClasses), or a brand NAME she typed. Prices are USD cents.
- "soft" carries everything about how the dress should look or be used: occasions, color families, fabrics, silhouettes.
- Vibe, mood, aesthetic, or season language ("summer", "cottagecore", "elegant", "flowy", "90s") must NEVER become a hard constraint. Put it in soft.vibeText as a short descriptive phrase, and map it onto soft enums only when the mapping is obvious (e.g. "bridal shower" → occasions ["wedding_guest"] is NOT obvious; "for the office" → ["work"] is).
- "petite"/"tall" are body descriptions, not sizes — vibeText, never sizesNormalized.
- Never invent constraints the query does not state. Use null for anything absent.`;

/** Normalized-query cache key — global, user-independent. */
export function queryParseCacheKey(q: string): string {
  const normalized = q.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

/** Cached entry: `parse: null` is a NEGATIVE entry (recent failure). */
export interface CachedQueryParse {
  parse: LlmQueryParse | null;
}

/** Cache port mirroring the `search_query_cache` table (db owns the Drizzle impl). */
export interface QueryParseCacheStore {
  get(cacheKey: string): Promise<CachedQueryParse | null>;
  set(cacheKey: string, value: CachedQueryParse, expiresAtMs: number): Promise<void>;
}

export class InMemoryQueryParseCache implements QueryParseCacheStore {
  private readonly map = new Map<string, { value: CachedQueryParse; expiresAtMs: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string): Promise<CachedQueryParse | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: CachedQueryParse, expiresAtMs: number): Promise<void> {
    this.map.set(key, { value, expiresAtMs });
  }
}

export interface QueryParserOptions {
  client?: AiClient;
  cache?: QueryParseCacheStore;
  timeoutMs?: number;
  maxOutputTokens?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface QueryParseOutcome {
  parse: LlmQueryParse;
  source: 'llm' | 'llm_cache';
  costUsd: number | null;
}

export type QueryParser = (q: string) => Promise<QueryParseOutcome | null>;

/** In-flight live parses, deduped per cache key process-wide. */
const inFlightParses = new Map<string, Promise<QueryParseOutcome | null>>();

/**
 * Build the stage-3 parser. `parse(q)` resolves null whenever the enrichment
 * is unavailable (keyless, over budget, negative-cached failure, timeout,
 * validation failure) — callers always have the stage-1 result already.
 */
export function createQueryParser(options: QueryParserOptions = {}): QueryParser {
  const client = options.client ?? createAiClient();
  const cache = options.cache ?? new InMemoryQueryParseCache(options.now);
  const timeoutMs = options.timeoutMs ?? QUERY_PARSE_TIMEOUT_MS;
  const maxTokens = options.maxOutputTokens ?? QUERY_PARSE_MAX_OUTPUT_TOKENS;
  const log = options.logger ?? ((m: string) => console.log(m));
  const now = options.now ?? Date.now;

  async function liveParse(q: string, cacheKey: string): Promise<QueryParseOutcome | null> {
    const anthropic = client.anthropic!;
    const model = client.models.rerank; // Haiku — same tier as the re-ranker
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        anthropic.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: [
              {
                type: 'text',
                text: QUERY_PARSE_SYSTEM_PROMPT,
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages: [{ role: 'user', content: `QUERY: ${q}` }],
            output_config: { format: zodOutputFormat(LlmQueryParseSchema) },
          },
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`query parse timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      const costUsd = client.meter.record(model, message.usage);
      if (message.stop_reason === 'max_tokens') {
        throw new Error(`query parse truncated at max_tokens=${maxTokens}`);
      }
      const text = message.content.find(
        (b): b is Extract<(typeof message.content)[number], { type: 'text' }> =>
          b.type === 'text',
      )?.text;
      if (!text) throw new Error('no text block in query parse response');
      const parse = LlmQueryParseSchema.parse(JSON.parse(text));
      await cache.set(cacheKey, { parse }, now() + QUERY_PARSE_TTL_MS);
      return { parse, source: 'llm', costUsd };
    } catch (err) {
      // Loud + short-TTL negative cache: a failing parse never re-bills
      // (or re-waits the timeout) on every keystroke-search for 5 minutes.
      log(
        `[QUERY-PARSE] live parse FAILED (negative-cached ${QUERY_PARSE_FAILURE_TTL_MS / 60_000}min): ${(err as Error).message}`,
      );
      try {
        await cache.set(cacheKey, { parse: null }, now() + QUERY_PARSE_FAILURE_TTL_MS);
      } catch {
        // cache write failure must not mask the degradation
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return async function parse(q: string): Promise<QueryParseOutcome | null> {
    if (!q.trim()) return null;
    const cacheKey = queryParseCacheKey(q);
    const cached = await cache.get(cacheKey);
    if (cached) {
      if (cached.parse === null) return null; // negative entry — stay stage-1
      return { parse: cached.parse, source: 'llm_cache', costUsd: 0 };
    }
    if (client.effectiveMode() === 'mock') return null; // keyless / over budget

    const inFlight = inFlightParses.get(cacheKey);
    if (inFlight) return inFlight;
    const p = liveParse(q, cacheKey).finally(() => inFlightParses.delete(cacheKey));
    inFlightParses.set(cacheKey, p);
    return p;
  };
}
