/**
 * Haiku personalized re-rank — docs/ARCHITECTURE.md §7.3.
 *
 * Input: user profile summary (~120 tokens) + numbered candidate ATTRIBUTE
 * summaries (id, brand, price, silhouette, colors, hem-position-on-user,
 * fabric, condition) — never images. Output: ranked ids + a one-line "why it
 * works for you" per item. System prompt + rubric are prompt-cached;
 * responses cached 24h keyed by (profileHash, sorted candidateIdsHash,
 * queryHash) to hold the ~$0.01/query budget. Keyless / over-budget →
 * deterministic fallback with templated why-lines.
 *
 * 2026-07-09 hardening (prod 15s-feed incident):
 * - max_tokens computed from the schema (2× worst case) instead of a fixed
 *   1200 that truncated every 50-candidate response;
 * - explicit truncation detection (stop_reason 'max_tokens') + 6s hard
 *   client-side timeout;
 * - failures negative-cache for 5 min (deterministic entry) so a failing
 *   rerank can't re-bill 10s + $ on every load;
 * - optional background mode: cache miss returns 'pending' immediately and
 *   fills the cache off the request path (see createReranker).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { RankedListing, UserProfile } from '@hemline/contracts';
import { createAiClient, type AiClient } from '../client';

export interface RerankResult {
  /** listing ids, best first */
  ranking: string[];
  /** listingId → one-line "why it works for you" */
  reasons: Record<string, string>;
  costUsd: number | null;
  /**
   * 'pending' (2026-07-09): deterministic order returned immediately; the LLM
   * call is filling the cache in the background (createReranker background
   * mode). Callers keep the incoming order and may re-check the cache later.
   */
  mode: 'llm' | 'deterministic' | 'cache' | 'pending';
}

export const RERANK_CACHE_TTL_MS = 24 * 60 * 60_000;
/**
 * Negative-cache TTL: a FAILED live rerank (truncation, timeout, parse error,
 * API error) writes a deterministic entry for 5 minutes so every feed load
 * doesn't re-pay a ~10s + $ live call that keeps failing (2026-07-09 prod
 * incident: truncated structured output → fallback on EVERY load).
 */
export const RERANK_FAILURE_TTL_MS = 5 * 60_000;
/** Hard client-side deadline on a BLOCKING live call — the feed must never wait longer. */
export const RERANK_TIMEOUT_MS = 6_000;
/**
 * Deadline for BACKGROUND fills: nothing user-facing waits on these, so they
 * get room to finish (live smoke 2026-07-09: a 24-candidate Haiku rerank runs
 * >6s end-to-end) while still bounding hung connections and spend.
 */
export const RERANK_BACKGROUND_TIMEOUT_MS = 30_000;
/** Reason lines are capped short so worst-case output stays small (see below). */
export const MAX_REASON_WORDS = 12;

/** Cache port mirroring the `rerank_cache` table (backend-eng persists it). */
export interface RerankCacheStore {
  get(cacheKey: string): Promise<RerankResult | null>;
  set(cacheKey: string, value: RerankResult, expiresAtMs: number): Promise<void>;
}

export class InMemoryRerankCache implements RerankCacheStore {
  private readonly map = new Map<string, { value: RerankResult; expiresAtMs: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string): Promise<RerankResult | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: RerankResult, expiresAtMs: number): Promise<void> {
    this.map.set(key, { value, expiresAtMs });
  }
}

/**
 * sha256(profileHash + candidateIdsHash + queryHash) — doc §3 rerank_cache.
 *
 * The candidate hash is over the SORTED id set (2026-07-09): the model is
 * asked to fully re-order the head, so its answer depends on WHICH candidates
 * are in it, not on the incoming deterministic order. Sorting makes the key
 * tolerant of score jitter that merely permutes the same head set (freshness
 * decay ticking, palette toggle re-ordering) — important while crawls churn
 * scores. Any change to the SET (new listing enters the head) still misses,
 * which is correct: new content deserves a fresh rerank.
 */
export function rerankCacheKey(
  profile: UserProfile,
  candidateIds: string[],
  query?: string,
): string {
  const profileHash = sha256(
    JSON.stringify([
      profile.heightInches,
      profile.heelPrefInches,
      profile.sizesNormalized,
      profile.lengthPrefs,
      profile.colorSeason,
      profile.palette,
      sortedEntries(profile.styleTags),
    ]),
  );
  const candidatesHash = sha256(JSON.stringify([...candidateIds].sort()));
  const queryHash = sha256(query ?? '');
  return sha256(profileHash + candidatesHash + queryHash);
}

const RERANK_SYSTEM_PROMPT = `You are Hemline's personal-stylist re-ranker. You receive one shopper profile and a numbered list of in-stock dress candidates (attributes only — no images). Re-order the candidates from best to worst match FOR THIS SHOPPER and give each a one-line reason.

Consider, in rough priority order:
1. Hem position on her body (hemOnHer) vs her stated length preferences.
2. Style fit: silhouette/color/fabric vs her learned style tags.
3. Color-season palette match, when she has one.
4. Value within budget and condition.

Rules:
- "reason" is ONE short sentence addressed to her ("Hits the knee on you, in your palette."), max ${MAX_REASON_WORDS} words.
- Include EVERY candidate id exactly once in "ranking".
- Never invent attributes that are not in the candidate summary.`;

const RerankModelOutputSchema = z.object({
  ranking: z.array(z.string()),
  reasons: z.array(z.object({ id: z.string(), reason: z.string() })),
});

/**
 * Worst-case output tokens for the structured rerank response
 * `{"ranking":[…ids],"reasons":[{"id":…,"reason":…},…]}`:
 * per candidate the id appears twice (ranking element ≈ idTokens+2 for
 * quotes/comma; reasons element ≈ idTokens + reason + ~8 structural tokens),
 * with the reason capped at MAX_REASON_WORDS words (≈1.5 tokens/word).
 * Ids are dense alphanumerics ≈ 3 chars/token (conservative).
 *
 * 2026-07-09 prod incident: 50 candidates × ~18-word reasons ⇒ ~3.3K worst-case
 * output tokens against max_tokens=1200 ⇒ EVERY response truncated
 * ("Unterminated string in JSON at position ~3000") ⇒ 10s + $ spent, then
 * deterministic fallback, uncached, on every personalized feed load.
 */
export function estimateRerankOutputTokens(
  ids: string[],
  maxReasonWords: number = MAX_REASON_WORDS,
): number {
  const envelope = 16; // {"ranking":[…],"reasons":[…]}
  const reasonTokens = Math.ceil(maxReasonWords * 1.5);
  let total = envelope;
  for (const id of ids) {
    const idTokens = Math.ceil(id.length / 3);
    total += idTokens + 2 + (idTokens + reasonTokens + 8);
  }
  return total;
}

/** max_tokens for the live call: 2× the worst case (headroom), min 512. */
export function rerankMaxOutputTokens(ids: string[]): number {
  return Math.max(512, 2 * estimateRerankOutputTokens(ids));
}

export interface RerankOptions {
  client?: AiClient;
  cache?: RerankCacheStore;
  /** Override the computed 2×-worst-case budget (tests / experiments only). */
  maxOutputTokens?: number;
  /** Hard client-side deadline for the live call (default RERANK_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * true → never block the caller on the LLM: cache hits apply synchronously,
   * misses return mode 'pending' immediately while the live call fills the
   * cache in the background (deduped per cache key across concurrent
   * requests). Failures negative-cache exactly like the blocking path.
   */
  background?: boolean;
  logger?: (message: string) => void;
  now?: () => number;
}

export type Reranker = (
  profile: UserProfile,
  candidates: RankedListing[],
  query?: string,
) => Promise<RerankResult>;

/** Reranker plus a test/ops hook to await outstanding background fills. */
export type RerankerHandle = Reranker & { flush(): Promise<void> };

/**
 * In-flight background fills, keyed by cache key, shared process-wide so two
 * concurrent feed loads for the same (profile, head, query) spend once.
 */
const inFlightFills = new Map<string, Promise<void>>();

export function createReranker(options: RerankOptions = {}): RerankerHandle {
  const client = options.client ?? createAiClient();
  const cache = options.cache ?? new InMemoryRerankCache(options.now);
  // Blocking calls sit on the request path → tight deadline; background fills
  // don't → room to actually finish (see constant docs).
  const timeoutMs =
    options.timeoutMs ??
    (options.background ? RERANK_BACKGROUND_TIMEOUT_MS : RERANK_TIMEOUT_MS);
  const log = options.logger ?? ((m: string) => console.log(m));
  const now = options.now ?? Date.now;

  /**
   * The live call. Throws on any failure — including an explicitly detected
   * truncation (stop_reason 'max_tokens') and the hard client-side timeout —
   * so callers uniformly negative-cache + degrade.
   */
  async function liveRerank(
    profile: UserProfile,
    candidates: RankedListing[],
    query: string | undefined,
    ids: string[],
    cacheKey: string,
  ): Promise<RerankResult> {
    const anthropic = client.anthropic!;
    const model = client.models.rerank;
    const maxTokens = options.maxOutputTokens ?? rerankMaxOutputTokens(ids);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        anthropic.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: [
              { type: 'text', text: RERANK_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
            ],
            messages: [
              {
                role: 'user',
                content: `${profileSummary(profile)}\n${query ? `SEARCH QUERY: ${query}\n` : ''}CANDIDATES:\n${candidates.map(candidateSummary).join('\n')}`,
              },
            ],
            output_config: { format: zodOutputFormat(RerankModelOutputSchema) },
          },
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`rerank timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      const costUsd = client.meter.record(model, message.usage);
      // Explicit truncation detection: never hand a cut-off JSON body to the
      // parser and mistake it for a model failure (2026-07-09 prod incident).
      if (message.stop_reason === 'max_tokens') {
        log(
          `[RERANK] TRUNCATED: hit max_tokens=${maxTokens} with ${ids.length} candidates (output_tokens=${message.usage.output_tokens}) — check estimateRerankOutputTokens sizing`,
        );
        throw new Error(`rerank output truncated at max_tokens=${maxTokens}`);
      }
      const text = message.content.find(
        (b): b is Extract<(typeof message.content)[number], { type: 'text' }> =>
          b.type === 'text',
      )?.text;
      if (!text) throw new Error('no text block in rerank response');
      const output = RerankModelOutputSchema.parse(JSON.parse(text));

      // Sanitize: keep only known ids, dedupe, append anything dropped.
      const known = new Set(ids);
      const seen = new Set<string>();
      const ranking: string[] = [];
      for (const id of output.ranking) {
        if (known.has(id) && !seen.has(id)) {
          ranking.push(id);
          seen.add(id);
        }
      }
      for (const id of ids) if (!seen.has(id)) ranking.push(id);
      const reasons: Record<string, string> = {};
      for (const { id, reason } of output.reasons) {
        if (known.has(id)) reasons[id] = reason;
      }

      const result: RerankResult = { ranking, reasons, costUsd, mode: 'llm' };
      await cache.set(cacheKey, result, now() + RERANK_CACHE_TTL_MS);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Loud log + short-TTL negative cache so a failing rerank can't re-bill every load. */
  async function failClosed(
    err: unknown,
    profile: UserProfile,
    candidates: RankedListing[],
    cacheKey: string,
  ): Promise<RerankResult> {
    log(`[RERANK] live re-rank FAILED, deterministic fallback (negative-cached ${RERANK_FAILURE_TTL_MS / 60_000}min): ${(err as Error).message}`);
    const fallback = deterministicRerank(profile, candidates);
    try {
      await cache.set(cacheKey, fallback, now() + RERANK_FAILURE_TTL_MS);
    } catch {
      // cache write failure must not mask the fallback
    }
    return fallback;
  }

  const rerank = async function rerank(
    profile: UserProfile,
    candidates: RankedListing[],
    query?: string,
  ): Promise<RerankResult> {
    if (candidates.length === 0) {
      return { ranking: [], reasons: {}, costUsd: null, mode: 'deterministic' };
    }

    const ids = candidates.map((c) => c.listing.id);
    const cacheKey = rerankCacheKey(profile, ids, query);
    const cached = await cache.get(cacheKey);
    if (cached) {
      // Negative entry (a recent failure): stay deterministic — honestly
      // reported, no re-spend within the failure TTL. Reasons/order are
      // recomputed fresh from the actual incoming candidates.
      if (cached.mode === 'deterministic') return deterministicRerank(profile, candidates);
      return { ...cached, costUsd: 0, mode: 'cache' };
    }

    if (client.effectiveMode() === 'mock') {
      log(`[MOCK] re-rank: deterministic order + templated reasons (${ids.length} candidates)`);
      return deterministicRerank(profile, candidates);
    }

    if (options.background) {
      if (!inFlightFills.has(cacheKey)) {
        const fill = liveRerank(profile, candidates, query, ids, cacheKey)
          .then(() => undefined)
          .catch(async (err) => {
            await failClosed(err, profile, candidates, cacheKey);
          })
          .finally(() => inFlightFills.delete(cacheKey));
        inFlightFills.set(cacheKey, fill);
      }
      // Serve the deterministic page NOW; the next request with the same head
      // hits the cache the background fill wrote ('cache' mode, synchronous).
      return { ranking: ids, reasons: {}, costUsd: null, mode: 'pending' };
    }

    try {
      return await liveRerank(profile, candidates, query, ids, cacheKey);
    } catch (err) {
      return failClosed(err, profile, candidates, cacheKey);
    }
  };

  return Object.assign(rerank, {
    async flush(): Promise<void> {
      await Promise.all([...inFlightFills.values()]);
    },
  });
}

/**
 * Keyless fallback (doc §7.5): keep the incoming deterministic score order and
 * template the why-lines from real attributes.
 */
export function deterministicRerank(
  profile: UserProfile,
  candidates: RankedListing[],
): RerankResult {
  const reasons: Record<string, string> = {};
  for (const c of candidates) {
    reasons[c.listing.id] = templatedWhy(profile, c);
  }
  return {
    ranking: candidates.map((c) => c.listing.id),
    reasons,
    costUsd: null,
    mode: 'deterministic',
  };
}

export function templatedWhy(profile: UserProfile, candidate: RankedListing): string {
  const parts: string[] = [];
  if (candidate.hem.position) {
    parts.push(`Hits ${candidate.hem.position.replace(/_/g, ' ')} on you`);
  }
  const paletteFamilies = new Set(profile.palette.map((p) => p.name.toLowerCase()));
  const paletteHit = candidate.listing.colors.find((c) =>
    paletteFamilies.has(c.name.toLowerCase()),
  );
  if (paletteHit) {
    parts.push(`${paletteHit.name} is in your palette`);
  } else if (profile.colorSeason) {
    const season = profile.colorSeason.replace(/_/g, ' ');
    const color = candidate.listing.colors[0];
    if (color) parts.push(`${color.name} works with your ${season} palette`);
  }
  if (parts.length < 2 && candidate.listing.silhouette) {
    parts.push(`${candidate.listing.silhouette.replace(/_/g, ' ')} shape suits your saved styles`);
  }
  if (parts.length === 0) {
    parts.push(`Fresh ${candidate.listing.brand ?? 'find'} in your size and budget`);
  }
  return parts.slice(0, 2).join(' and ') + '.';
}

function profileSummary(profile: UserProfile): string {
  const tags = sortedEntries(profile.styleTags)
    .filter(([, w]) => w > 0)
    .slice(0, 12)
    .map(([t]) => t)
    .join(', ');
  const dislikes = sortedEntries(profile.styleTags)
    .filter(([, w]) => w < 0)
    .slice(-6)
    .map(([t]) => t)
    .join(', ');
  return [
    'SHOPPER PROFILE:',
    `height: ${profile.heightInches ?? 'unknown'}in, usual heel ${profile.heelPrefInches}in`,
    `sizes (US): ${profile.sizesNormalized.join(', ') || 'unknown'}`,
    `preferred hem positions on her: ${profile.lengthPrefs.join(', ') || 'no preference'}`,
    `color season: ${profile.colorSeason ?? 'unknown'}; palette: ${profile.palette.map((p) => p.name).join(', ') || 'none'}`,
    `budget: ${formatBudget(profile)}`,
    `style tags she likes: ${tags || 'none learned yet'}`,
    `style tags she dislikes: ${dislikes || 'none'}`,
  ].join('\n');
}

function candidateSummary(c: RankedListing, index: number): string {
  const l = c.listing;
  return `${index + 1}. id=${l.id} | ${l.brand ?? 'unbranded'} | $${(l.priceCents / 100).toFixed(0)} | ${l.condition}${l.isVintage ? ' vintage' : ''} | silhouette=${l.silhouette ?? '?'} | colors=${l.colors.map((col) => col.name).join('/') || '?'} | fabric=${l.fabric ?? '?'} | hemOnHer=${c.hem.position ?? 'unknown'} (${c.hem.confidence})`;
}

function formatBudget(profile: UserProfile): string {
  const { minCents, maxCents } = profile.budget;
  if (minCents == null && maxCents == null) return 'no limit';
  const lo = minCents != null ? `$${Math.round(minCents / 100)}` : '$0';
  const hi = maxCents != null ? `$${Math.round(maxCents / 100)}` : 'open';
  return `${lo}–${hi}`;
}

function sortedEntries(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1]);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Convenience singleton matching the original stub's signature. */
let defaultReranker: Reranker | null = null;
export async function rerank(
  profile: UserProfile,
  candidates: RankedListing[],
): Promise<RerankResult> {
  defaultReranker ??= createReranker();
  return defaultReranker(profile, candidates);
}
