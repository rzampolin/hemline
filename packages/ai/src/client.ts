/**
 * Anthropic SDK wrapper — docs/ARCHITECTURE.md §7.1.
 *
 * TODO(ai-eng): @anthropic-ai/sdk client, cost meter summing `usage` into a
 * daily ledger, AI_DAILY_BUDGET_USD hard cap (default 5) → automatic mock mode.
 */

export type AiMode = 'live' | 'mock';

/** Mode detection is real (graceful degradation §7.5); everything else is stubbed. */
export function resolveAiMode(env: NodeJS.ProcessEnv = process.env): AiMode {
  return env.ANTHROPIC_API_KEY ? 'live' : 'mock';
}

export function createAnthropicClient(): never {
  throw new Error(
    'not yet implemented (ai-eng): Anthropic SDK wrapper with cost meter — docs/ARCHITECTURE.md §7.1',
  );
}
