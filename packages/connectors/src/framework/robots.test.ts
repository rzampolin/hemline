import { describe, expect, it, vi } from 'vitest';
import { createRobotsGate, isPathAllowed, parseRobots } from './robots';

const SHOPIFY_DEFAULT = `
# we use Shopify as our ecommerce platform
User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts/
Disallow: /checkout
Disallow: /account
Disallow: /collections/*sort_by*
Disallow: /*/collections/*sort_by*
Disallow: /*?*oseid=*
Disallow: /*preview_theme_id*
Sitemap: https://example.com/sitemap.xml
`;

describe('isPathAllowed', () => {
  it('allows /products.json under the default Shopify robots.txt', () => {
    expect(isPathAllowed(SHOPIFY_DEFAULT, '/products.json')).toBe(true);
    expect(isPathAllowed(SHOPIFY_DEFAULT, '/checkout')).toBe(false);
    expect(isPathAllowed(SHOPIFY_DEFAULT, '/collections/all?sort_by=price')).toBe(false);
  });

  it('honors an explicit disallow of products.json', () => {
    const txt = 'User-agent: *\nDisallow: /products.json';
    expect(isPathAllowed(txt, '/products.json')).toBe(false);
  });

  it('prefers a SolineBot-specific group over *', () => {
    const txt = `
User-agent: *
Disallow: /

User-agent: SolineBot
Allow: /products.json
Disallow: /
`;
    expect(isPathAllowed(txt, '/products.json')).toBe(true);
    expect(isPathAllowed(txt, '/cart')).toBe(false);
  });

  it('longest match wins; Allow wins ties; empty file allows all', () => {
    const txt = 'User-agent: *\nDisallow: /p\nAllow: /products.json';
    expect(isPathAllowed(txt, '/products.json')).toBe(true);
    expect(isPathAllowed(txt, '/pages')).toBe(false);
    expect(isPathAllowed('', '/anything')).toBe(true);
  });

  it('supports $ end anchors', () => {
    const txt = 'User-agent: *\nDisallow: /*.json$';
    expect(isPathAllowed(txt, '/products.json')).toBe(false);
    expect(isPathAllowed(txt, '/products.jsonl')).toBe(true);
  });

  it('parses stacked user-agent lines into one group', () => {
    const groups = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x');
    expect(groups).toHaveLength(1);
    expect(groups[0].agents).toEqual(['a', 'b']);
  });
});

describe('createRobotsGate', () => {
  it('fetches robots.txt once per origin (cached) and treats 404 as allowed', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const gate = createRobotsGate({ fetchImpl: fetchImpl as unknown as typeof fetch, minDelayMs: 0 });
    expect(await gate.isAllowed('https://a.example', '/products.json')).toBe(true);
    expect(await gate.isAllowed('https://a.example', '/anything')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces disallow from a fetched robots.txt', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('User-agent: *\nDisallow: /products.json', { status: 200 }),
    );
    const gate = createRobotsGate({ fetchImpl: fetchImpl as unknown as typeof fetch, minDelayMs: 0 });
    expect(await gate.isAllowed('https://b.example', '/products.json')).toBe(false);
  });
});
