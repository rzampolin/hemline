/**
 * Anthropic SDK wrapper — docs/ARCHITECTURE.md §7.1.
 *
 * One place owns: the SDK client, the model ids (env-overridable), the cost
 * meter (sums `usage` from every response into a daily ledger), and the
 * AI_DAILY_BUDGET_USD hard cap. When the cap is exceeded — or no key is set —
 * every capability degrades to its deterministic mock (§7.5).
 */
import Anthropic from '@anthropic-ai/sdk';

export type AiMode = 'live' | 'mock';

export const DEFAULT_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_RERANK_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_COLOR_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_DAILY_BUDGET_USD = 5;

/** USD per million tokens, per model family (doc §7.1). */
const PRICING_PER_MTOK: Array<{ match: RegExp; inputUsd: number; outputUsd: number }> = [
  { match: /haiku-4-5/, inputUsd: 1, outputUsd: 5 },
  { match: /sonnet-4-6/, inputUsd: 3, outputUsd: 15 },
];
/** Message Batches API bills at 50% of live prices. */
export const BATCH_DISCOUNT = 0.5;

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface CostLedgerEntry {
  day: string; // YYYY-MM-DD (UTC)
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostMeter {
  /** Record one response's usage. Returns the estimated cost in USD. */
  record(model: string, usage: UsageLike, opts?: { batch?: boolean }): number;
  /** Total spend for a UTC day (default: today). */
  totalUsd(day?: string): number;
  /** True once today's spend has crossed the daily budget. */
  overBudget(): boolean;
  readonly dailyBudgetUsd: number;
  ledger(): CostLedgerEntry[];
}

export function estimateCostUsd(
  model: string,
  usage: UsageLike,
  opts: { batch?: boolean } = {},
): number {
  const pricing = PRICING_PER_MTOK.find((p) => p.match.test(model)) ?? {
    inputUsd: 3,
    outputUsd: 15,
  };
  // Cache reads bill ~0.1× input, cache writes ~1.25×.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputUsd =
    ((usage.input_tokens + 0.1 * cacheRead + 1.25 * cacheWrite) / 1_000_000) *
    pricing.inputUsd;
  const outputUsd = (usage.output_tokens / 1_000_000) * pricing.outputUsd;
  const discount = opts.batch ? BATCH_DISCOUNT : 1;
  return (inputUsd + outputUsd) * discount;
}

export function createCostMeter(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): CostMeter {
  const dailyBudgetUsd = parseBudget(env.AI_DAILY_BUDGET_USD);
  const entries = new Map<string, CostLedgerEntry>(); // key: day|model

  function today(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  return {
    dailyBudgetUsd,
    record(model, usage, opts) {
      const cost = estimateCostUsd(model, usage, opts);
      const day = today();
      const key = `${day}|${model}`;
      const entry = entries.get(key) ?? {
        day,
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      entry.calls += 1;
      entry.inputTokens +=
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      entry.outputTokens += usage.output_tokens;
      entry.costUsd += cost;
      entries.set(key, entry);
      return cost;
    },
    totalUsd(day = today()) {
      let sum = 0;
      for (const e of entries.values()) if (e.day === day) sum += e.costUsd;
      return sum;
    },
    overBudget() {
      return this.totalUsd() >= dailyBudgetUsd;
    },
    ledger() {
      return [...entries.values()];
    },
  };
}

export interface AiClient {
  /** Mode at construction; consult `effectiveMode()` before each call. */
  readonly mode: AiMode;
  /** null in mock mode. */
  readonly anthropic: Anthropic | null;
  readonly meter: CostMeter;
  readonly models: { extraction: string; rerank: string; color: string };
  /** 'mock' when keyless OR the daily budget is exhausted (§7.1 hard cap). */
  effectiveMode(): AiMode;
}

/** Mode detection (graceful degradation §7.5). */
export function resolveAiMode(env: NodeJS.ProcessEnv = process.env): AiMode {
  return env.ANTHROPIC_API_KEY ? 'live' : 'mock';
}

export function createAiClient(env: NodeJS.ProcessEnv = process.env): AiClient {
  const mode = resolveAiMode(env);
  const meter = createCostMeter(env);
  const anthropic =
    mode === 'live' ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  return {
    mode,
    anthropic,
    meter,
    models: {
      extraction: env.EXTRACTION_MODEL || DEFAULT_EXTRACTION_MODEL,
      rerank: env.RERANK_MODEL || DEFAULT_RERANK_MODEL,
      color: env.COLOR_MODEL || DEFAULT_COLOR_MODEL,
    },
    effectiveMode() {
      if (mode === 'mock') return 'mock';
      return meter.overBudget() ? 'mock' : 'live';
    },
  };
}

function parseBudget(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

/**
 * Does this API failure mean "the API could not fetch a url-sourced file we
 * referenced"? Two phrasings seen live so far (both 400 invalid_request_error
 * on listing image URLs):
 *   - "Unable to download the file. Please verify the URL and try again."
 *     (2026-07, Reformation Cloudinary URLs)
 *   - "The request timed out while trying to download the file. Please try
 *     again later." (2026-07, prod — the old verb-anchored regex missed it
 *     and the listing fell back to mock)
 * The API rewords these freely, so the detector matches SEMANTICS, not one
 * phrasing: a 400/invalid_request_error whose text (a) is about
 * downloading/fetching/retrieving a file/url/image and (b) reads as a
 * failure (unable/failed/cannot/timed out/error…), in either order.
 *
 * Accepts both thrown SDK APIErrors and Message Batches `errored` result
 * payloads ({ type: 'error', error: { type, message } }). The listing itself
 * is fine — only the image block is; callers should retry text-only
 * (extraction) or mark the row not-estimable (vision lengths) instead of
 * treating it as a model/service failure.
 */
export function isImageUrlDownloadError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; message?: string; error?: unknown };
  let text = typeof e.message === 'string' ? e.message : '';
  try {
    text += ' ' + JSON.stringify(e.error ?? '');
  } catch {
    // circular error payload — match on message alone
  }
  const invalidRequest = e.status === 400 || /invalid_request_error/i.test(text);
  if (!invalidRequest) return false;
  const aboutDownloadingAFile =
    /\b(download(?:ing|ed)?|fetch(?:ing|ed)?|retriev(?:e|ed|ing|al))\b[\s\S]{0,120}\b(file|url|image)s?\b/i.test(
      text,
    ) ||
    /\b(file|url|image)s?\b[\s\S]{0,120}\b(download(?:ing|ed)?|fetch(?:ing|ed)?|retriev(?:e|ed|ing|al))\b/i.test(
      text,
    );
  const readsAsFailure =
    /\b(unable|failed|failure|error|could\s*not|couldn'?t|cannot|can'?t|timed?[\s-]?out)\b/i.test(
      text,
    );
  return aboutDownloadingAFile && readsAsFailure;
}
