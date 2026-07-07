/**
 * Content-hash recipe — docs/ARCHITECTURE.md §7.2:
 *   content_hash = sha256(title|desc|price|images|sizes)
 *
 * Side-effect-free module (decisions-data-eng.md #8): both the seed loader and
 * the ingest pipeline import THIS so the recipe can never drift between them
 * (a drift would silently re-extract the whole catalog).
 */
import { createHash } from 'node:crypto';

export interface ContentHashInput {
  title: string;
  description?: string;
  priceCents: number;
  imageUrls: string[];
  sizeLabels: string[];
}

export function contentHashFor(e: ContentHashInput): string {
  return createHash('sha256')
    .update(
      [
        e.title,
        e.description ?? '',
        String(e.priceCents),
        e.imageUrls.join(','),
        e.sizeLabels.join(','),
      ].join('|'),
    )
    .digest('hex');
}
