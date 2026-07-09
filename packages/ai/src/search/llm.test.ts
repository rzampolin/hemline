import { describe, expect, it, vi } from 'vitest';
import { createAiClient, createCostMeter, type AiClient } from '../client';
import {
  createQueryParser,
  InMemoryQueryParseCache,
  LlmQueryParseSchema,
  queryParseCacheKey,
  QUERY_PARSE_FAILURE_TTL_MS,
  QUERY_PARSE_TTL_MS,
  type LlmQueryParse,
} from './llm';
import { mergeQueryParse } from './merge';
import { parseQueryDeterministic } from './parse';

const MOCK_ENV = {} as NodeJS.ProcessEnv;

type CreateFn = (req: unknown, opts?: unknown) => Promise<unknown>;

function liveClient(create: CreateFn): AiClient {
  return {
    mode: 'live',
    anthropic: { messages: { create } } as unknown as NonNullable<AiClient['anthropic']>,
    meter: createCostMeter({} as NodeJS.ProcessEnv),
    models: {
      extraction: 'claude-haiku-4-5-20251001',
      rerank: 'claude-haiku-4-5-20251001',
      color: 'claude-sonnet-4-6',
    },
    effectiveMode: () => 'live',
  };
}

function llmMessage(output: unknown, stopReason = 'end_turn') {
  return {
    stop_reason: stopReason,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { input_tokens: 400, output_tokens: 120 },
  };
}

const PARSE_SUMMER_FORMAL: LlmQueryParse = {
  hard: {
    priceMinCents: null,
    priceMaxCents: null,
    sizesNormalized: null,
    lengthClasses: null,
    brands: null,
  },
  soft: {
    occasions: ['formal'],
    colorFamilies: null,
    fabrics: ['chiffon'],
    silhouettes: null,
    vibeText: 'light summery elegant',
  },
};

describe('LlmQueryParseSchema (the model contract)', () => {
  it('accepts a well-formed parse', () => {
    expect(LlmQueryParseSchema.parse(PARSE_SUMMER_FORMAL)).toBeTruthy();
  });

  it('rejects out-of-taxonomy enum values (occasions, silhouettes, color families)', () => {
    const bad = structuredClone(PARSE_SUMMER_FORMAL) as Record<string, any>;
    bad.soft.occasions = ['gala'];
    expect(LlmQueryParseSchema.safeParse(bad).success).toBe(false);
    const bad2 = structuredClone(PARSE_SUMMER_FORMAL) as Record<string, any>;
    bad2.soft.colorFamilies = ['chartreuse-ish'];
    expect(LlmQueryParseSchema.safeParse(bad2).success).toBe(false);
    const bad3 = structuredClone(PARSE_SUMMER_FORMAL) as Record<string, any>;
    bad3.hard.lengthClasses = ['extra-long'];
    expect(LlmQueryParseSchema.safeParse(bad3).success).toBe(false);
  });
});

describe('cache key (global, user-independent)', () => {
  it('normalizes case + whitespace', () => {
    expect(queryParseCacheKey('  Summer   FORMAL ')).toBe(queryParseCacheKey('summer formal'));
    expect(queryParseCacheKey('summer formal')).not.toBe(queryParseCacheKey('winter formal'));
  });
});

describe('createQueryParser', () => {
  it('keyless client → null, no API call', async () => {
    const create = vi.fn();
    const parser = createQueryParser({
      client: createAiClient(MOCK_ENV),
      cache: new InMemoryQueryParseCache(),
      logger: () => {},
    });
    expect(await parser('summer formal keyless')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('over-budget client → null (budget guard)', async () => {
    const create = vi.fn();
    const client = liveClient(create);
    (client as { effectiveMode: () => 'live' | 'mock' }).effectiveMode = () => 'mock';
    const parser = createQueryParser({
      client,
      cache: new InMemoryQueryParseCache(),
      logger: () => {},
    });
    expect(await parser('summer formal broke')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('live success → parse returned + cached with the long TTL; repeat = cache hit', async () => {
    let nowMs = 1_000;
    const create = vi.fn(async () => llmMessage(PARSE_SUMMER_FORMAL));
    const cache = new InMemoryQueryParseCache(() => nowMs);
    const parser = createQueryParser({
      client: liveClient(create),
      cache,
      logger: () => {},
      now: () => nowMs,
    });
    const r1 = await parser('summer formal live');
    expect(r1?.source).toBe('llm');
    expect(r1?.parse.soft.occasions).toEqual(['formal']);
    expect(r1?.costUsd).toBeGreaterThan(0);

    const r2 = await parser('summer formal live');
    expect(r2?.source).toBe('llm_cache');
    expect(r2?.costUsd).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);

    // just before the 30d TTL the entry is still valid
    nowMs = 1_000 + QUERY_PARSE_TTL_MS - 1;
    expect((await parser('summer formal live'))?.source).toBe('llm_cache');
  });

  it('schema-invalid response → null + short negative cache (no re-bill inside the TTL)', async () => {
    let nowMs = 0;
    const create = vi.fn(async () => llmMessage({ hard: {}, soft: { occasions: ['gala'] } }));
    const cache = new InMemoryQueryParseCache(() => nowMs);
    const parser = createQueryParser({
      client: liveClient(create),
      cache,
      logger: () => {},
      now: () => nowMs,
    });
    expect(await parser('bad response query')).toBeNull();
    expect(await parser('bad response query')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1); // negative-cached

    nowMs = QUERY_PARSE_FAILURE_TTL_MS + 1; // negative entry expired → retry
    await parser('bad response query');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('hangs past the hard timeout → null + negative cache', async () => {
    const create = vi.fn(() => new Promise(() => {})); // never settles
    const cache = new InMemoryQueryParseCache();
    const parser = createQueryParser({
      client: liveClient(create as CreateFn),
      cache,
      timeoutMs: 20,
      logger: () => {},
    });
    expect(await parser('hanging query')).toBeNull();
    expect(await parser('hanging query')).toBeNull(); // negative entry, no second call
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('sends the system prompt with prompt caching and the query in the user turn', async () => {
    const create = vi.fn(async (_req: unknown) => llmMessage(PARSE_SUMMER_FORMAL));
    const parser = createQueryParser({
      client: liveClient(create),
      cache: new InMemoryQueryParseCache(),
      logger: () => {},
    });
    await parser('inspect the request');
    const req = create.mock.calls[0][0] as {
      system: Array<{ cache_control?: unknown }>;
      messages: Array<{ content: string }>;
      output_config: unknown;
    };
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.messages[0].content).toContain('inspect the request');
    expect(req.output_config).toBeTruthy();
  });
});

describe('mergeQueryParse (stage 3 enriches stage 1, never overrides it)', () => {
  const KNOWN_BRANDS = ['STAUD', 'STAUD FALL 2025', 'Reformation'];
  const llmParse = (overrides: Partial<LlmQueryParse['hard']> = {}, soft: Partial<LlmQueryParse['soft']> = {}): LlmQueryParse => ({
    hard: {
      priceMinCents: null,
      priceMaxCents: null,
      sizesNormalized: null,
      lengthClasses: null,
      brands: null,
      ...overrides,
    },
    soft: {
      occasions: null,
      colorFamilies: null,
      fabrics: null,
      silhouettes: null,
      vibeText: null,
      ...soft,
    },
  });

  it('stage-1 hard values win; the LLM only fills gaps', () => {
    const stage1 = parseQueryDeterministic('under $150');
    const merged = mergeQueryParse(stage1, llmParse({ priceMaxCents: 99900 }));
    expect(merged.hard.priceMaxCents).toBe(15000);
  });

  it('LLM fills a missing price and adds a chip signal', () => {
    const stage1 = parseQueryDeterministic('cheap and cheerful');
    const merged = mergeQueryParse(stage1, llmParse({ priceMaxCents: 10000 }));
    expect(merged.hard.priceMaxCents).toBe(10000);
    expect(merged.signals).toContainEqual({
      kind: 'price',
      term: 'under $100',
      value: 'under $100',
      hard: true,
    });
  });

  it('LLM brands validate against the catalog; hallucinations never hard-filter', () => {
    const stage1 = parseQueryDeterministic('that designer look');
    const merged = mergeQueryParse(stage1, llmParse({ brands: ['staud', 'Balenciaga'] }), {
      knownBrands: KNOWN_BRANDS,
    });
    expect(merged.hard.brands).toEqual(expect.arrayContaining(['STAUD', 'STAUD FALL 2025']));
    expect(merged.hard.brands).not.toContain('Balenciaga');
  });

  it('soft signals union without duplicates', () => {
    const stage1 = parseQueryDeterministic('silk formal');
    const merged = mergeQueryParse(
      stage1,
      llmParse({}, { occasions: ['formal', 'cocktail'], fabrics: ['Silk charmeuse'] }),
    );
    expect(merged.soft.occasions).toEqual(['formal', 'cocktail']);
    expect(merged.soft.fabrics).toEqual(['silk']); // deduped by first word
  });

  it('un-chipped values are dropped from LLM additions (chip removal survives the global cache)', () => {
    const stage1 = parseQueryDeterministic('summer party look', { excludeTerms: ['cocktail'] });
    const merged = mergeQueryParse(stage1, llmParse({}, { occasions: ['cocktail'], vibeText: 'summer cocktail vibes' }), {
      excludeTerms: ['cocktail'],
    });
    expect(merged.soft.occasions).toEqual(['party']);
    expect(merged.vibeText).toBe('summer vibes');
  });

  it('null LLM parse is the identity', () => {
    const stage1 = parseQueryDeterministic('summer formal');
    const merged = mergeQueryParse(stage1, null);
    expect(merged).toEqual({ ...stage1, vibeText: null });
  });
});
