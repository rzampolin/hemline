import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeSitemapBody,
  decodeXmlEntities,
  parseSitemapXml,
  sitemapUrlsFromRobots,
} from './sitemap';

describe('parseSitemapXml', () => {
  it('parses a urlset (loc + optional lastmod/changefreq noise)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc> https://www.thereformation.com/products/gene-dress/0103940.html </loc>
          <lastmod>2026-03-23T19:38:43+00:00</lastmod><changefreq>daily</changefreq></url>
        <url><loc>https://www.thereformation.com/products/tagliatelle-dress/0104217.html</loc></url>
      </urlset>`;
    const doc = parseSitemapXml(xml);
    expect(doc.kind).toBe('urlset');
    expect(doc.locs).toEqual([
      'https://www.thereformation.com/products/gene-dress/0103940.html',
      'https://www.thereformation.com/products/tagliatelle-dress/0104217.html',
    ]);
    // lastmod pairs with its loc (freshness-ordered crawling)
    expect(doc.entries[0].lastmodMs).toBe(Date.parse('2026-03-23T19:38:43+00:00'));
    expect(doc.entries[1].lastmodMs).toBeUndefined();
  });

  it('parses a sitemap index and decodes XML entities in locs (BigCommerce shape)', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://realisationpar.com/xmlsitemap.php?type=products&amp;page=1</loc></sitemap>
      <sitemap><loc>https://realisationpar.com/xmlsitemap.php?type=categories&amp;page=1</loc></sitemap>
    </sitemapindex>`;
    const doc = parseSitemapXml(xml);
    expect(doc.kind).toBe('index');
    expect(doc.locs).toEqual([
      'https://realisationpar.com/xmlsitemap.php?type=products&page=1',
      'https://realisationpar.com/xmlsitemap.php?type=categories&page=1',
    ]);
  });

  it('treats a loc-less document as an empty urlset', () => {
    expect(parseSitemapXml('<html>not a sitemap</html>')).toEqual({
      kind: 'urlset',
      locs: [],
      entries: [],
    });
  });
});

describe('sitemapUrlsFromRobots', () => {
  it('extracts Sitemap: lines case-insensitively, deduped, order-preserving', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /cart',
      'Sitemap: https://www.thereformation.com/sitemap_index.xml',
      'sitemap: https://www.thereformation.fr/sitemap_index.xml',
      'Sitemap: https://www.thereformation.com/sitemap_index.xml',
    ].join('\n');
    expect(sitemapUrlsFromRobots(robots)).toEqual([
      'https://www.thereformation.com/sitemap_index.xml',
      'https://www.thereformation.fr/sitemap_index.xml',
    ]);
  });

  it('returns [] when robots.txt declares no sitemaps', () => {
    expect(sitemapUrlsFromRobots('User-agent: *\nDisallow: /checkout\n')).toEqual([]);
  });
});

describe('decodeSitemapBody', () => {
  const xml = '<urlset><url><loc>https://x.test/a</loc></url></urlset>';

  it('decodes plain UTF-8', () => {
    expect(decodeSitemapBody(new TextEncoder().encode(xml))).toBe(xml);
  });

  it('gunzips raw-gzip payloads (*.xml.gz served without Content-Encoding)', () => {
    const gz = gzipSync(Buffer.from(xml, 'utf-8'));
    expect(decodeSitemapBody(new Uint8Array(gz))).toBe(xml);
  });
});

describe('decodeXmlEntities', () => {
  it('handles named, decimal and hex entities', () => {
    expect(decodeXmlEntities('a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#x27; f&nbsp;g')).toBe(
      'a&b <c> "d" \'e\' f g',
    );
  });
});
