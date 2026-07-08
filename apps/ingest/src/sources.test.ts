import { describe, expect, it } from 'vitest';
import { buildConnectors, parseArgs } from './sources';

describe('buildConnectors — source/store selection', () => {
  it('default run includes fixtures, ebay, verified shopify AND verified jsonld stores', () => {
    const ids = buildConnectors({}).map((c) => c.id);
    expect(ids).toContain('fixtures');
    expect(ids).toContain('ebay');
    expect(ids).toContain('shopify:staud.clothing');
    expect(ids).toContain('jsonld:thereformation.com');
    // unverified stores stay out of default runs
    expect(ids).not.toContain('jsonld:sezane.com');
    expect(ids).not.toContain('jsonld:aritzia.com');
  });

  it('--source=jsonld selects every verified jsonld store, nothing else', () => {
    const connectors = buildConnectors({ source: 'jsonld' });
    expect(connectors.length).toBeGreaterThanOrEqual(4);
    expect(connectors.every((c) => c.kind === 'jsonld')).toBe(true);
  });

  it('--source=jsonld:<domain> selects exactly that store', () => {
    const connectors = buildConnectors({ source: 'jsonld:thereformation.com' });
    expect(connectors.map((c) => c.id)).toEqual(['jsonld:thereformation.com']);
  });

  it('--source=jsonld:<unknown> fails loudly (patterns are required config)', () => {
    expect(() => buildConnectors({ source: 'jsonld:nope.example' })).toThrow(/jsonld-stores\.json/);
  });

  it('--store=<domain> picks jsonld when configured there, shopify otherwise', () => {
    expect(buildConnectors({ store: 'thereformation.com' }).map((c) => c.id)).toEqual([
      'jsonld:thereformation.com',
    ]);
    expect(buildConnectors({ store: 'staud.clothing' }).map((c) => c.id)).toEqual([
      'shopify:staud.clothing',
    ]);
  });

  it('--source=shopify:<domain> still forces the shopify connector on a clash', () => {
    expect(buildConnectors({ source: 'shopify:thereformation.com' }).map((c) => c.id)).toEqual([
      'shopify:thereformation.com',
    ]);
  });
});

describe('parseArgs', () => {
  it('parses --source/--store/--watch/--no-extract', () => {
    expect(parseArgs(['--source=jsonld', '--store=lulus.com', '--watch', '--no-extract'])).toEqual({
      source: 'jsonld',
      store: 'lulus.com',
      watch: true,
      extract: false,
      embed: true, // --no-embed not passed
    });
  });

  it('parses --no-embed (mirrors --no-extract)', () => {
    expect(parseArgs(['--no-embed'])).toMatchObject({ extract: true, embed: false });
  });
});
