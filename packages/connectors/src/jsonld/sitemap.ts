/**
 * Sitemap discovery/parsing for the JSON-LD connector (pure functions).
 *
 * We only need `<loc>` extraction from `<urlset>` / `<sitemapindex>` docs plus
 * `Sitemap:` lines from robots.txt, so this is regex-based — no XML dependency.
 * Handles XML-entity-encoded locs (BigCommerce emits `&amp;` in sitemap URLs)
 * and gzipped sitemap bodies (`*.xml.gz` serve raw gzip that fetch does NOT
 * transparently decode — only Content-Encoding responses are).
 */
import { gunzipSync } from 'node:zlib';

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

export interface SitemapEntry {
  loc: string;
  /** epoch ms parsed from <lastmod>, when present and valid */
  lastmodMs?: number;
}

export interface SitemapDoc {
  kind: 'index' | 'urlset';
  /** child-sitemap URLs (index) or page URLs (urlset), entity-decoded */
  locs: string[];
  /** urlset entries with per-URL lastmod (freshest-first crawl ordering) */
  entries: SitemapEntry[];
}

const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/i;
const LASTMOD_RE = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;

export function parseSitemapXml(xml: string): SitemapDoc {
  const kind: SitemapDoc['kind'] = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const entries: SitemapEntry[] = [];

  // per-<url>/<sitemap> blocks so lastmod pairs with its loc
  for (const m of xml.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/gi)) {
    const block = m[2];
    const loc = block.match(LOC_RE);
    if (!loc) continue;
    const url = decodeXmlEntities(loc[1]);
    if (!url) continue;
    const lastmod = block.match(LASTMOD_RE);
    const ms = lastmod ? Date.parse(lastmod[1]) : NaN;
    entries.push(Number.isFinite(ms) ? { loc: url, lastmodMs: ms } : { loc: url });
  }

  // fallback for docs with bare <loc>s outside url/sitemap wrappers
  if (entries.length === 0) {
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const url = decodeXmlEntities(m[1]);
      if (url) entries.push({ loc: url });
    }
  }

  return { kind, locs: entries.map((e) => e.loc), entries };
}

/** `Sitemap:` declarations from robots.txt (order-preserving). */
export function sitemapUrlsFromRobots(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const m of robotsTxt.matchAll(/^[ \t]*sitemap:[ \t]*(\S+)/gim)) {
    if (!urls.includes(m[1])) urls.push(m[1]);
  }
  return urls;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Decode a sitemap body: gunzip when the payload is raw gzip, else UTF-8. */
export function decodeSitemapBody(buf: Uint8Array): string {
  const bytes =
    buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]
      ? gunzipSync(buf)
      : buf;
  return new TextDecoder('utf-8').decode(bytes);
}
