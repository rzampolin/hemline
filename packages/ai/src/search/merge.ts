/**
 * Merge the stage-3 (Haiku) query parse INTO the stage-1 (deterministic)
 * result — pure. Stage 1 always ran; the LLM is enrichment only:
 *
 * - hard fields: stage 1 wins per-field (deterministic price/size/length/
 *   brand extraction is exact); the LLM fills gaps only.
 * - LLM brands are validated against the stored brand labels
 *   (expandKnownBrand) — a hallucinated brand can never hard-filter.
 * - soft signals: union.
 * - vibeText: appended to the semantic query material.
 * - excludeTerms (un-chipped): any LLM addition whose value matches an
 *   excluded term is dropped, so chip removal survives the global parse cache.
 */
import type { LlmQueryParse } from './llm';
import { expandKnownBrand, type ParsedQuery, type QuerySignal } from './parse';

export interface MergedQuery extends ParsedQuery {
  /** Haiku's mood/season/style phrase, if any — semantic query material. */
  vibeText: string | null;
}

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

export function mergeQueryParse(
  stage1: ParsedQuery,
  llm: LlmQueryParse | null,
  opts: { knownBrands?: string[]; excludeTerms?: string[] } = {},
): MergedQuery {
  if (!llm) return { ...stage1, vibeText: null };
  const excluded = new Set((opts.excludeTerms ?? []).map((t) => t.trim().toLowerCase()));
  const isExcluded = (...terms: Array<string | null | undefined>) =>
    terms.some((t) => t != null && excluded.has(t.trim().toLowerCase()));

  const hard = { ...stage1.hard };
  const soft = {
    occasions: [...stage1.soft.occasions],
    colorFamilies: [...stage1.soft.colorFamilies],
    fabrics: [...stage1.soft.fabrics],
    silhouettes: [...stage1.soft.silhouettes],
    necklines: [...stage1.soft.necklines],
    patterns: [...stage1.soft.patterns],
  };
  const signals: QuerySignal[] = [...stage1.signals];

  // ── hard: fill gaps only (stage 1 wins) ─────────────────────────────────
  if (hard.priceMinCents == null && hard.priceMaxCents == null) {
    const min = llm.hard.priceMinCents ?? undefined;
    const max = llm.hard.priceMaxCents ?? undefined;
    if (min != null || max != null) {
      hard.priceMinCents = min;
      hard.priceMaxCents = max;
      const label =
        min != null && max != null
          ? `$${Math.round(min / 100)}–$${Math.round(max / 100)}`
          : max != null
            ? `under $${Math.round(max / 100)}`
            : `over $${Math.round(min! / 100)}`;
      if (!isExcluded(label)) {
        signals.push({ kind: 'price', term: label, value: label, hard: true });
      } else {
        hard.priceMinCents = undefined;
        hard.priceMaxCents = undefined;
      }
    }
  }
  if (!hard.sizesNormalized?.length && llm.hard.sizesNormalized?.length) {
    const sizes = llm.hard.sizesNormalized.filter((s) => s >= 0 && s <= 26);
    for (const s of sizes) {
      if (isExcluded(`size ${s}`, String(s))) continue;
      hard.sizesNormalized = unique([...(hard.sizesNormalized ?? []), s]);
      signals.push({ kind: 'size', term: `size ${s}`, value: `size ${s}`, hard: true });
    }
  }
  if (!hard.lengthClasses?.length && llm.hard.lengthClasses?.length) {
    for (const lc of llm.hard.lengthClasses) {
      if (isExcluded(lc)) continue;
      hard.lengthClasses = [...(hard.lengthClasses ?? []), lc];
      signals.push({ kind: 'length', term: lc, value: lc, hard: true });
    }
  }
  if (!hard.brands?.length && llm.hard.brands?.length) {
    for (const name of llm.hard.brands) {
      if (isExcluded(name)) continue;
      const match = expandKnownBrand(name, opts.knownBrands ?? []);
      if (!match) continue; // unknown brand — never hard-filter on it
      hard.brands = unique([...(hard.brands ?? []), ...match.expanded]);
      signals.push({ kind: 'brand', term: name, value: match.canonical, hard: true });
    }
  }

  // ── soft: union ─────────────────────────────────────────────────────────
  const addSoft = (
    kind: QuerySignal['kind'],
    list: string[],
    additions: string[] | null | undefined,
    normalize: (v: string) => string = (v) => v,
  ) => {
    for (const raw of additions ?? []) {
      const v = normalize(raw);
      if (!v || list.includes(v) || isExcluded(v, raw)) continue;
      list.push(v);
      signals.push({ kind, term: v, value: v, hard: false });
    }
  };
  addSoft('occasion', soft.occasions, llm.soft.occasions);
  addSoft('color', soft.colorFamilies, llm.soft.colorFamilies, (v) => v.toLowerCase());
  addSoft('fabric', soft.fabrics, llm.soft.fabrics, (v) =>
    v.toLowerCase().split(/\s+/)[0],
  );
  addSoft(
    'silhouette',
    soft.silhouettes as string[],
    llm.soft.silhouettes,
  );

  // ── vibe: semantic material, minus un-chipped words ─────────────────────
  let vibeText: string | null = null;
  if (llm.soft.vibeText?.trim()) {
    const kept = llm.soft.vibeText
      .split(/\s+/)
      .filter((w) => !excluded.has(w.trim().toLowerCase()));
    vibeText = kept.length > 0 ? kept.join(' ') : null;
  }

  return {
    signals,
    hard,
    soft,
    residualTokens: stage1.residualTokens,
    semanticText: stage1.semanticText,
    vibeText,
  };
}
