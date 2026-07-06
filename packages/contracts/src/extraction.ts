/**
 * Extraction service contracts — docs/ARCHITECTURE.md §4.3
 * Boundary: ai-eng ⇄ data-eng. FROZEN.
 *
 * `ExtractedAttributes` / `ExtractedAttributesSchema` are defined in
 * `./listing.ts` (import-cycle avoidance — docs/DECISIONS.md #1) and exported
 * from the package root.
 */
import { z } from 'zod';
import { ExtractedAttributesSchema } from './listing';
import type { ExtractedAttributes } from './listing';

export const ExtractionInputSchema = z.object({
  /** cache key — service MUST check cache first */
  contentHash: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  brand: z.string().nullable(),
  /** Haiku vision on ONE image max */
  primaryImageUrl: z.string().nullable(),
  attributeHints: ExtractedAttributesSchema.partial().nullable(),
  sizeLabels: z.array(z.string()),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;

export interface ExtractionService {
  /** Idempotent: cache hit → no API call. Batches internally (up to 100/call window). */
  extractBatch(inputs: ExtractionInput[]): Promise<Map<string, ExtractedAttributes>>;
  /** 'live' (API key present) or 'mock' (deterministic rule-based fallback) */
  readonly mode: 'live' | 'mock';
}
