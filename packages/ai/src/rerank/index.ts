/**
 * Haiku personalized re-rank — docs/ARCHITECTURE.md §7.3.
 *
 * TODO(ai-eng): profile summary + candidate summaries → { ranking, reasons },
 * prompt-cached, response cached in rerank_cache (24h TTL). Deterministic
 * fallback lives in packages/matching (scoring.ts).
 */
import type { RankedListing, UserProfile } from '@hemline/contracts';

export interface RerankResult {
  ranking: string[];
  reasons: Record<string, string>;
  costUsd: number | null;
}

export async function rerank(
  _profile: UserProfile,
  _candidates: RankedListing[],
): Promise<RerankResult> {
  throw new Error('not yet implemented (ai-eng): Haiku re-rank — docs/ARCHITECTURE.md §7.3');
}
