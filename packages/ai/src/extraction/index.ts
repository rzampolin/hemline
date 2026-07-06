/**
 * Attribute/measurement extraction — docs/ARCHITECTURE.md §7.2.
 *
 * TODO(ai-eng):
 * - mock mode FIRST (deterministic rule engine, confidence ≤ 0.4) — unblocks data-eng
 * - live mode: Haiku via Message Batches API, prompt-cached system block,
 *   zodOutputFormat(ExtractedAttributesSchema), two-pass image strategy
 * - idempotent by content_hash against the `extractions` table
 */
import type { ExtractionService } from '@hemline/contracts';
import { resolveAiMode } from '../client';

export function createExtractionService(): ExtractionService {
  return {
    mode: resolveAiMode(),
    async extractBatch() {
      throw new Error(
        'not yet implemented (ai-eng): extraction service — docs/ARCHITECTURE.md §7.2',
      );
    },
  };
}
