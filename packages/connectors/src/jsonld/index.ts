/**
 * Generic JSON-LD / sitemap connector — ingests any store that embeds
 * schema.org Product JSON-LD in its product pages (Google Shopping requires
 * it, so most fashion retailers do).
 *
 * Discovery:  robots.txt → Sitemap: lines (or store.sitemapUrl override, or
 *             /sitemap.xml) → sitemap indexes → product URLs filtered by the
 *             per-store productUrlPattern, dress-keyword URLs first, capped
 *             per run (default 500 — skips are LOGGED, never silent).
 * Extraction: politeFetch per PDP (per-host delay, HemlineBot UA, per-URL
 *             ETag/If-None-Match — a 304 re-emits the stored listing), robots
 *             gate per path, JSON-LD → RawListing (normalize.ts).
 * Isolation:  per-URL try/catch; a consecutive-failure circuit breaker stops
 *             a store that starts bot-blocking mid-crawl instead of hammering
 *             it for the rest of the URL list.
 */
import type { FetchContext, FetchResult, RawListing, SourceConnector } from '@hemline/contracts';
import { createMemoryEtagCache } from '../framework/etag-cache';
import { loadExistingRawListings } from '../framework/existing-listings';
import { politeFetch, type PolitenessOptions } from '../framework/politeness';
import { isPathAllowed } from '../framework/robots';
import { extractListingFromHtml, type JsonldStoreInfo } from './normalize';
import { decodeSitemapBody, parseSitemapXml, sitemapUrlsFromRobots } from './sitemap';
import storesJson from './jsonld-stores.json';

export * from './normalize';
export * from './extract';
export * from './microdata';
export * from './sitemap';

export interface JsonldStore extends JsonldStoreInfo {
  /** probed live: sitemap reachable + one PDP yields Product JSON-LD w/ price */
  verified: boolean;
  notes?: string;
}

export const jsonldStores: JsonldStore[] = storesJson as JsonldStore[];

/** Stores the default ingest run crawls (probed live — see jsonld-stores.json). */
export function verifiedJsonldStores(): JsonldStore[] {
  return jsonldStores.filter((s) => s.verified);
}

export function findJsonldStore(domain: string): JsonldStore | undefined {
  return jsonldStores.find((s) => s.domain === domain);
}

export interface JsonldConnectorOptions extends PolitenessOptions {
  /** max product pages fetched per store per run (default JSONLD_MAX_PAGES or 500) */
  maxProductPages?: number;
  /** max sitemap documents fetched during discovery (default 12) */
  maxSitemapFetches?: number;
  /** consecutive PDP failures before the store is abandoned this run (default 8) */
  maxConsecutiveErrors?: number;
}

export function defaultMaxProductPages(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.JSONLD_MAX_PAGES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500;
}

const DRESS_URL_RE = /dress/i;

/**
 * Crawl-order the capped budget: dress-keyword URLs first, freshest lastmod
 * first within each group (sold-out/archived products cluster at old
 * lastmods — verified live on thereformation.com), original order as
 * tiebreak.
 */
export function orderProductUrls(
  urls: string[],
  lastmodByUrl: Map<string, number> = new Map(),
): string[] {
  const rank = new Map(urls.map((u, i) => [u, i]));
  const byFreshness = (a: string, b: string): number => {
    const diff = (lastmodByUrl.get(b) ?? 0) - (lastmodByUrl.get(a) ?? 0);
    return diff !== 0 ? diff : rank.get(a)! - rank.get(b)!;
  };
  const dress: string[] = [];
  const rest: string[] = [];
  for (const u of urls) (DRESS_URL_RE.test(u) ? dress : rest).push(u);
  return [...dress.sort(byFreshness), ...rest.sort(byFreshness)];
}

export function createJsonldConnector(
  store: JsonldStoreInfo,
  opts: JsonldConnectorOptions = {},
): SourceConnector {
  const sourceId = `jsonld:${store.domain}`;

  return {
    id: sourceId,
    kind: 'jsonld',
    defaultCadence: '30 6 * * *', // daily, offset from the Shopify 06:00 wave
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      // No credentials needed, but crawling can be disabled in dev.
      return env.INGEST_ENABLE_JSONLD !== 'false';
    },
    async fetchListings(ctx: FetchContext): Promise<FetchResult> {
      const log = ctx.logger;
      if (ctx.mockMode) {
        log.info(`[${sourceId}] crawling disabled (INGEST_ENABLE_JSONLD=false) — skipping`);
        return { listings: [], stats: { fetched: 0, errors: 0 } };
      }

      const maxPages = opts.maxProductPages ?? defaultMaxProductPages();
      const maxSitemaps = opts.maxSitemapFetches ?? 12;
      const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 8;
      const origin = `https://${store.domain}`;
      const etagCache = ctx.etagCache ?? createMemoryEtagCache();
      let errors = 0;

      // ── robots.txt: sitemap discovery + path gate (one fetch, reused) ──
      let robotsTxt: string | null = null;
      try {
        const res = await politeFetch(`${origin}/robots.txt`, undefined, opts);
        robotsTxt = res.ok ? await res.text() : null;
      } catch {
        robotsTxt = null; // unreachable robots → allowed (decisions doc #4)
      }
      const allowed = (url: string): boolean => {
        if (robotsTxt == null) return true;
        const u = new URL(url);
        return isPathAllowed(robotsTxt, u.pathname + u.search);
      };

      // ── sitemap discovery ────────────────────────────────────────────
      const seeds = store.sitemapUrl
        ? [store.sitemapUrl]
        : (() => {
            const fromRobots = sitemapUrlsFromRobots(robotsTxt ?? '').filter((u) => {
              try {
                return new URL(u).hostname.endsWith(store.domain);
              } catch {
                return false;
              }
            });
            return fromRobots.length > 0 ? fromRobots : [`${origin}/sitemap.xml`];
          })();

      const pageUrls = new Set<string>();
      const lastmodByUrl = new Map<string, number>();
      const queue = [...seeds];
      const visited = new Set<string>();
      let sitemapFetches = 0;
      while (queue.length > 0 && sitemapFetches < maxSitemaps) {
        const url = queue.shift()!;
        if (visited.has(url)) continue;
        visited.add(url);
        if (!allowed(url)) {
          log.warn(`[${sourceId}] robots.txt disallows sitemap ${url} — skipping`);
          continue;
        }
        sitemapFetches += 1;
        try {
          const res = await politeFetch(url, { headers: { accept: 'application/xml' } }, opts);
          if (!res.ok) {
            log.warn(`[${sourceId}] sitemap ${url} → HTTP ${res.status}`);
            errors += 1;
            continue;
          }
          const xml = decodeSitemapBody(new Uint8Array(await res.arrayBuffer()));
          const doc = parseSitemapXml(xml);
          if (doc.kind === 'index') {
            // prefer product-named children when the index distinguishes them
            const children = doc.locs.filter((c) => /product/i.test(c));
            const pick = children.length > 0 ? children : doc.locs;
            const room = maxSitemaps - sitemapFetches;
            if (pick.length > room) {
              log.warn(
                `[${sourceId}] sitemap index ${url}: ${pick.length} children, fetching first ${room} (maxSitemapFetches=${maxSitemaps})`,
              );
            }
            queue.push(...pick);
          } else {
            for (const entry of doc.entries) {
              pageUrls.add(entry.loc);
              if (entry.lastmodMs != null) lastmodByUrl.set(entry.loc, entry.lastmodMs);
            }
          }
        } catch (e) {
          errors += 1;
          log.warn(`[${sourceId}] sitemap ${url} failed`, e);
        }
      }

      if (pageUrls.size === 0) {
        log.warn(`[${sourceId}] no sitemap URLs discovered — skipping store`);
        return { listings: [], stats: { fetched: 0, errors } };
      }

      // ── product-URL filter + cap (skips logged, never silent) ─────────
      const pattern = new RegExp(store.productUrlPattern, 'i');
      // per-store exclusion escape hatch (kids/junior lines living under a
      // dedicated URL path — audience gate, founder bug 2026-07-09)
      const excludePatterns = (store.excludeUrlPatterns ?? []).map((p) => new RegExp(p, 'i'));
      let excludedByPattern = 0;
      const matched = orderProductUrls(
        [...pageUrls].filter((u) => {
          if (!pattern.test(u)) return false;
          if (excludePatterns.some((re) => re.test(u))) {
            excludedByPattern += 1;
            return false;
          }
          return true;
        }),
        lastmodByUrl,
      );
      if (excludedByPattern > 0) {
        log.info(
          `[${sourceId}] excludeUrlPatterns skipped ${excludedByPattern} URL(s)`,
        );
      }
      const toCrawl = matched.slice(0, maxPages);
      log.info(
        `[${sourceId}] discovery: ${pageUrls.size} sitemap URLs → ${matched.length} product URLs`,
      );
      if (matched.length > toCrawl.length) {
        log.warn(
          `[${sourceId}] page cap: crawling ${toCrawl.length}, SKIPPING ${matched.length - toCrawl.length} product URLs this run (JSONLD_MAX_PAGES=${maxPages})`,
        );
      }

      // known listings by sourceUrl → a 304 PDP re-emits, bumping last_seen_at
      let existingByUrl = new Map<string, RawListing>();
      try {
        existingByUrl = new Map(
          loadExistingRawListings(ctx.db, sourceId, Date.now()).map((l) => [l.sourceUrl, l]),
        );
      } catch {
        // no db / schema in this context (unit tests) → conditional reuse off
      }

      // ── PDP crawl ─────────────────────────────────────────────────────
      const listings: RawListing[] = [];
      const seen = new Set<string>();
      const misses: Record<string, number> = {};
      let robotsSkipped = 0;
      let notModified = 0;
      let consecutiveErrors = 0;

      for (const url of toCrawl) {
        if (!allowed(url)) {
          robotsSkipped += 1;
          continue;
        }
        try {
          const headers: Record<string, string> = { accept: 'text/html' };
          const cached = await etagCache.get(url);
          if (cached?.etag) headers['if-none-match'] = cached.etag;
          if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

          const res = await politeFetch(url, { headers }, opts);

          if (res.status === 304) {
            const known = existingByUrl.get(url);
            if (known && !seen.has(known.sourceListingId)) {
              seen.add(known.sourceListingId);
              listings.push({ ...known, seenAt: Date.now() });
            }
            notModified += 1;
            consecutiveErrors = 0;
            continue;
          }
          if (!res.ok) {
            errors += 1;
            consecutiveErrors += 1;
            log.warn(`[${sourceId}] HTTP ${res.status} on ${url}`);
            if (consecutiveErrors >= maxConsecutiveErrors) {
              log.warn(
                `[${sourceId}] ${consecutiveErrors} consecutive failures — abandoning store this run (likely bot-blocked)`,
              );
              break;
            }
            continue;
          }
          consecutiveErrors = 0;

          const etag = res.headers.get('etag') ?? undefined;
          const lastModified = res.headers.get('last-modified') ?? undefined;
          if (etag || lastModified) await etagCache.set(url, { etag, lastModified });

          const html = await res.text();
          const { listing, outcome, malformedBlocks } = extractListingFromHtml(
            html,
            store,
            url,
            Date.now(),
          );
          if (malformedBlocks > 0 && outcome === 'malformed_only') {
            log.warn(`[${sourceId}] only malformed JSON-LD on ${url}`);
          }
          if (listing) {
            if (!seen.has(listing.sourceListingId)) {
              seen.add(listing.sourceListingId);
              listings.push(listing);
            }
          } else {
            misses[outcome] = (misses[outcome] ?? 0) + 1;
          }
        } catch (e) {
          errors += 1;
          consecutiveErrors += 1;
          log.warn(`[${sourceId}] ${url} failed`, e);
          if (consecutiveErrors >= maxConsecutiveErrors) {
            log.warn(
              `[${sourceId}] ${consecutiveErrors} consecutive failures — abandoning store this run`,
            );
            break;
          }
        }
      }

      const missSummary = Object.entries(misses)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      log.info(
        `[${sourceId}] crawl done: ${listings.length} dresses (304s=${notModified} robots-skipped=${robotsSkipped} errors=${errors}${missSummary ? ` ${missSummary}` : ''})`,
      );
      return { listings, stats: { fetched: listings.length, errors } };
    },
  };
}
