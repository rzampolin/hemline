/**
 * Thin typed API client for apps/web — every call typed with
 * @hemline/contracts request/response shapes (docs/ARCHITECTURE.md §4.7).
 *
 * NEXT_PUBLIC_API_MOCK=1 → client-side mock layer (lib/mock) with realistic
 * fixture-derived data. Unset → real fetches against app/api route handlers
 * (backend-eng). Flip the env var, nothing else changes.
 */
import type {
  ApiResponse,
  BrandSizesPut,
  ColorAnalysisPut,
  ColorAnalysisQuizRequest,
  ColorAnalysisResult,
  ListingDetailResponse,
  MetaFiltersResponse,
  ProfilePatch,
  RankedListing,
  RankResponse,
  SwipeEvent,
  SwipesPost,
  SwipesPostResponse,
  UserProfile,
} from '@hemline/contracts';
import {
  MockApiError,
  mockColorAnalysis,
  mockColorAnalysisQuiz,
  mockGetListing,
  mockGetMetaFilters,
  mockGetSession,
  mockPatchProfile,
  mockPostSwipes,
  mockPutBrandSizes,
  mockPutColorSeason,
  mockRank,
  mockSimilarSearch,
  type FeedRankRequest,
  type SimilarSearchInput,
  type SimilarSearchResult,
} from './mock/mock-api';
import { KEYS, readLocal, writeLocal } from './local';

export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MOCK === '1';

export { MockApiError as ApiError };
export type { FeedRankRequest, FeedFilters, SourceKindFilter } from './mock/mock-api';
export type { SimilarSearchInput, SimilarSearchResult } from './mock/mock-api';

/* ── live fetch helper (ApiResponse envelope per contracts) ──────────────── */

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new MockApiError('bad_response', `Unexpected response from ${path} (${res.status})`);
  }
  if (!body.ok) throw new MockApiError(body.error.code, body.error.message);
  return body.data;
}

/* ── the client ──────────────────────────────────────────────────────────── */

export const api = {
  getSession(): Promise<UserProfile> {
    return MOCK_MODE ? mockGetSession() : http<UserProfile>('/api/session');
  },

  patchProfile(patch: ProfilePatch): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPatchProfile(patch)
      : http<UserProfile>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  putBrandSizes(sizes: BrandSizesPut): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPutBrandSizes(sizes)
      : http<UserProfile>('/api/profile/brand-sizes', { method: 'PUT', body: JSON.stringify(sizes) });
  },

  postSwipes(events: SwipesPost): Promise<SwipesPostResponse> {
    return MOCK_MODE
      ? mockPostSwipes(events)
      : http<SwipesPostResponse>('/api/swipes', { method: 'POST', body: JSON.stringify(events) });
  },

  /**
   * Feed + search + deck all go through rank. `filters.sources` is now a real
   * (additive) HardFilters facet — the backend expands the 'resale' | 'brand'
   * aliases into source ids, so the live path sends it through untouched.
   */
  rank(req: FeedRankRequest) {
    if (MOCK_MODE) return mockRank(req);
    return http<RankResponse>('/api/rank', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  getListing(id: string): Promise<ListingDetailResponse> {
    return MOCK_MODE
      ? mockGetListing(id)
      : http<ListingDetailResponse>(`/api/listings/${encodeURIComponent(id)}`);
  },

  colorAnalysis(selfie: File): Promise<ColorAnalysisResult> {
    if (MOCK_MODE) return mockColorAnalysis(selfie);
    const form = new FormData();
    form.append('selfie', selfie);
    return http<ColorAnalysisResult>('/api/color-analysis', { method: 'POST', body: form });
  },

  colorAnalysisQuiz(req: ColorAnalysisQuizRequest): Promise<ColorAnalysisResult> {
    return MOCK_MODE
      ? mockColorAnalysisQuiz(req)
      : http<ColorAnalysisResult>('/api/color-analysis/quiz', {
          method: 'POST',
          body: JSON.stringify(req),
        });
  },

  putColorSeason(req: ColorAnalysisPut): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPutColorSeason(req)
      : http<UserProfile>('/api/color-analysis', { method: 'PUT', body: JSON.stringify(req) });
  },

  getMetaFilters(): Promise<MetaFiltersResponse> {
    return MOCK_MODE ? mockGetMetaFilters() : http<MetaFiltersResponse>('/api/meta/filters');
  },

  /**
   * Saved items ("My Rack", spec F1). Live mode uses the real rack endpoints
   * (GET/POST /api/saves + DELETE /api/saves/:id) so saves live server-side;
   * mock mode keeps the localStorage ids + detail hydration.
   */
  async getSaved(): Promise<RankedListing[]> {
    if (!MOCK_MODE) {
      const res = await http<{ items: RankedListing[]; staleIds: string[] }>('/api/saves');
      return res.items;
    }
    const ids = readLocal<string[]>(KEYS.saved, []);
    const results = await Promise.allSettled(ids.map((id) => api.getListing(id)));
    return results
      .filter((r): r is PromiseFulfilledResult<ListingDetailResponse> => r.status === 'fulfilled')
      .map((r) => ({
        listing: r.value.listing,
        hem: r.value.hem,
        score: 1,
        whyItWorks: null,
        freshnessDecay: 1,
      }));
  },

  /** Saved listing ids (rack hydration on session load). */
  async getSavedIdsRemote(): Promise<string[]> {
    if (MOCK_MODE) return readLocal<string[]>(KEYS.saved, []);
    const res = await http<{ items: RankedListing[] }>('/api/saves');
    return res.items.map((i) => i.listing.id);
  },

  /** One-tap save (heart). Mock mode records a 'save' swipe for taste parity. */
  save(listingId: string, context: SwipeEvent['context'] = 'feed'): Promise<unknown> {
    return MOCK_MODE
      ? mockPostSwipes([{ listingId, verdict: 'save', context }])
      : http<{ saved: boolean }>('/api/saves', {
          method: 'POST',
          body: JSON.stringify({ listingId, context }),
        });
  },

  /** Un-save. Idempotent server-side; a no-op in mock mode (local list rules). */
  unsave(listingId: string): Promise<unknown> {
    return MOCK_MODE
      ? Promise.resolve()
      : http<{ saved: boolean }>(`/api/saves/${encodeURIComponent(listingId)}`, {
          method: 'DELETE',
        });
  },

  /**
   * "Find dresses like this" (B4) — live mode hits the real
   * POST /api/find-similar (multipart photo | JSON { imageUrl | hint });
   * mock mode keeps the deterministic client-side attribute matcher.
   */
  async similarSearch(input: SimilarSearchInput): Promise<SimilarSearchResult> {
    if (MOCK_MODE) return mockSimilarSearch(input);

    let res: FindSimilarResponse;
    if (input.file) {
      const form = new FormData();
      form.append('photo', input.file);
      res = await http<FindSimilarResponse>('/api/find-similar', { method: 'POST', body: form });
    } else {
      const isHttp = input.url != null && /^https?:\/\//i.test(input.url);
      const body = isHttp
        ? { imageUrl: input.url }
        : { hint: input.url ?? input.fileName ?? 'dress' };
      res = await http<FindSimilarResponse>('/api/find-similar', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }

    return {
      inferred: { descriptor: describeAttributes(res.attributes) },
      results: {
        items: res.items,
        nextCursor: null,
        totalMatched: res.totalMatched,
        rerank: { mode: 'deterministic', costUsd: null },
      },
    };
  },
};

/* ── find-similar response shape (additive route, not in frozen §4.7) ─────── */

interface FindSimilarResponse {
  attributes: Record<string, number>;
  /** 'skipped' when the FashionSigLIP visual path answered (no extraction ran) */
  extractionMode: 'live' | 'mock' | 'skipped';
  /** additive: which similarity backend produced the ranking */
  matchBasis?: 'embedding' | 'attributes';
  fallback: 'none' | 'nearest';
  items: RankedListing[];
  totalMatched: number;
}

/** Sparse tag vector → human descriptor ("green, wrap, midi length"). */
function describeAttributes(vector: Record<string, number>): string {
  const parts = Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => {
      const [kind, value] = tag.split(':');
      const pretty = (value ?? tag).replace(/_/g, ' ');
      return kind === 'length' ? `${pretty} length` : pretty;
    });
  return parts.length > 0 ? parts.join(', ') : 'similar dresses';
}

/* ── saved ids (client-side, shared by both modes) ───────────────────────── */

export function getSavedIds(): string[] {
  return readLocal<string[]>(KEYS.saved, []);
}

export function setSavedIds(ids: string[]): void {
  writeLocal(KEYS.saved, ids);
}
