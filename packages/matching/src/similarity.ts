/**
 * Attribute similarity — docs/ARCHITECTURE.md §6.
 * TODO(ai-eng): cosine over sparse tag→weight vectors. Keep pure; this sits
 * behind the StyleSimilarity upgrade path (sqlite-vec + FashionSigLIP later).
 */

export function attributeSimilarity(
  _userStyleTags: Record<string, number>,
  _listingAttributeVector: Record<string, number>,
): number {
  throw new Error(
    'not yet implemented (ai-eng): sparse cosine similarity — docs/ARCHITECTURE.md §6',
  );
}
