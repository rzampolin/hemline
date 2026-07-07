/**
 * Haiku personalized re-rank — docs/ARCHITECTURE.md §7.3.
 *
 * Input: user profile summary (~120 tokens) + numbered candidate ATTRIBUTE
 * summaries (id, brand, price, silhouette, colors, hem-position-on-user,
 * fabric, condition) — never images. Output: ranked ids + a one-line "why it
 * works for you" per item. System prompt + rubric are prompt-cached;
 * responses cached 24h keyed by (profileHash, candidateIdsHash, queryHash)
 * to hold the ~$0.01/query budget. Keyless / over-budget → deterministic
 * fallback with templated why-lines.
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
  mode: 'llm' | 'deterministic' | 'cache';
}

export const RERANK_CACHE_TTL_MS = 24 * 60 * 60_000;

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

/** sha256(profileHash + candidateIdsHash + queryHash) — doc §3 rerank_cache. */
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
  const candidatesHash = sha256(JSON.stringify(candidateIds));
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
- "reason" is ONE short sentence addressed to her ("Hits the knee on you and matches your soft-autumn palette."), max ~18 words.
- Include EVERY candidate id exactly once in "ranking".
- Never invent attributes that are not in the candidate summary.`;

const RerankModelOutputSchema = z.object({
  ranking: z.array(z.string()),
  reasons: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export interface RerankOptions {
  client?: AiClient;
  cache?: RerankCacheStore;
  maxOutputTokens?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

export type Reranker = (
  profile: UserProfile,
  candidates: RankedListing[],
  query?: string,
) => Promise<RerankResult>;

export function createReranker(options: RerankOptions = {}): Reranker {
  const client = options.client ?? createAiClient();
  const cache = options.cache ?? new InMemoryRerankCache(options.now);
  const maxOutputTokens = options.maxOutputTokens ?? 1200;
  const log = options.logger ?? ((m: string) => console.log(m));
  const now = options.now ?? Date.now;

  return async function rerank(profile, candidates, query) {
    if (candidates.length === 0) {
      return { ranking: [], reasons: {}, costUsd: null, mode: 'deterministic' };
    }

    const ids = candidates.map((c) => c.listing.id);
    const cacheKey = rerankCacheKey(profile, ids, query);
    const cached = await cache.get(cacheKey);
    if (cached) return { ...cached, costUsd: 0, mode: 'cache' };

    if (client.effectiveMode() === 'mock') {
      log(`[MOCK] re-rank: deterministic order + templated reasons (${ids.length} candidates)`);
      return deterministicRerank(profile, candidates);
    }

    try {
      const anthropic = client.anthropic!;
      const model = client.models.rerank;
      const message = await anthropic.messages.parse({
        model,
        max_tokens: maxOutputTokens,
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
      });
      const costUsd = client.meter.record(model, message.usage);
      const output = message.parsed_output;
      if (!output) throw new Error('no parsed_output in response');

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
    } catch (err) {
      log(`[MOCK] re-rank fallback (deterministic): ${(err as Error).message}`);
      return deterministicRerank(profile, candidates);
    }
  };
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
