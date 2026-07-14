/**
 * SSRF guard matrix (paste-a-dress-link fit check, 2026-07-13).
 *
 * The fit check fetches user-supplied URLs server-side — every private/
 * reserved destination in this file MUST be blocked, including redirect
 * bounces and hostnames that resolve to private addresses (DNS rebinding).
 */
import { describe, expect, it } from 'vitest';
import {
  isPrivateAddress,
  isPrivateIpv4,
  safeFetchExternalPage,
  validateExternalUrl,
  type Resolver,
} from '../lib/safe-url';

const publicResolver: Resolver = async () => [{ address: '93.184.216.34' }];
const privateResolver: Resolver = async () => [{ address: '10.0.0.5' }];

describe('isPrivateIpv4 / isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.9.9.9',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '192.0.0.170',
    '198.18.0.1',
    '224.0.0.1', // multicast
    '255.255.255.255',
  ])('blocks private/reserved IPv4 %s', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '151.101.1.140'])('allows public IPv4 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    '::1', // loopback
    '::', // unspecified
    'fc00::1', // unique-local
    'fd12:3456::1',
    'fe80::1', // link-local
    '::ffff:10.0.0.1', // IPv4-mapped private
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 space
  ])('blocks private/reserved IPv6 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('treats non-IP garbage as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('validateExternalUrl', () => {
  it('rejects non-https schemes', async () => {
    expect((await validateExternalUrl('http://store.com/x', publicResolver))).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect((await validateExternalUrl('ftp://store.com/x', publicResolver)).ok).toBe(false);
    expect((await validateExternalUrl('file:///etc/passwd', publicResolver)).ok).toBe(false);
  });

  it('rejects malformed URLs', async () => {
    expect((await validateExternalUrl('not a url', publicResolver))).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });

  it('rejects non-default ports', async () => {
    expect((await validateExternalUrl('https://store.com:8443/x', publicResolver))).toEqual({
      ok: false,
      reason: 'blocked_port',
    });
    expect((await validateExternalUrl('https://store.com:443/x', publicResolver)).ok).toBe(true);
  });

  it('rejects URLs with embedded credentials', async () => {
    expect((await validateExternalUrl('https://user:pass@store.com/x', publicResolver))).toEqual({
      ok: false,
      reason: 'blocked_credentials',
    });
  });

  it.each([
    'https://localhost/admin',
    'https://sub.localhost/x',
    'https://router.local/x',
    'https://db.internal/x',
    'https://host.home.arpa/x',
    'https://metadata.google.internal/computeMetadata/v1/',
  ])('rejects blocked hostname %s', async (url) => {
    expect((await validateExternalUrl(url, publicResolver))).toEqual({
      ok: false,
      reason: 'blocked_hostname',
    });
  });

  it.each([
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://192.168.0.10/x',
    'https://[::1]/x',
    'https://[fc00::1]/x',
  ])('rejects private IP-literal %s', async (url) => {
    expect((await validateExternalUrl(url, publicResolver))).toEqual({
      ok: false,
      reason: 'private_address',
    });
  });

  it('rejects hostnames that RESOLVE to private addresses (DNS rebinding)', async () => {
    expect((await validateExternalUrl('https://evil.example.com/x', privateResolver))).toEqual({
      ok: false,
      reason: 'private_address',
    });
    // even ONE private record among public ones blocks the URL
    const mixed: Resolver = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    expect((await validateExternalUrl('https://evil.example.com/x', mixed)).ok).toBe(false);
  });

  it('rejects unresolvable hostnames', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect((await validateExternalUrl('https://nope.example.com/x', failing))).toEqual({
      ok: false,
      reason: 'dns_failure',
    });
  });

  it('accepts a public https URL', async () => {
    const r = await validateExternalUrl('https://staud.clothing/products/x', publicResolver);
    expect(r.ok).toBe(true);
  });
});

describe('safeFetchExternalPage', () => {
  const htmlResponse = (body: string, init: ResponseInit = {}): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

  it('fetches a valid page and returns the body', async () => {
    const res = await safeFetchExternalPage('https://store.com/products/dress', {
      resolver: publicResolver,
      fetchImpl: async () => htmlResponse('<html>hi</html>'),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toBe('<html>hi</html>');
  });

  it('blocks a redirect to a private address', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('store.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        });
      }
      throw new Error('must never fetch the private hop');
    };
    const res = await safeFetchExternalPage('https://store.com/products/dress', {
      resolver: publicResolver,
      fetchImpl,
    });
    expect(res).toEqual({ ok: false, kind: 'blocked', reason: 'private_address' });
  });

  it('blocks a redirect that downgrades to http', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      fetchImpl: async () =>
        new Response(null, { status: 301, headers: { location: 'http://store.com/x' } }),
    });
    expect(res).toEqual({ ok: false, kind: 'blocked', reason: 'not_https' });
  });

  it('blocks a redirect to a hostname resolving privately (rebinding hop)', async () => {
    const resolver: Resolver = async (hostname) =>
      hostname === 'inner.evil.com' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('inner.evil.com')) throw new Error('must never fetch the private hop');
      return new Response(null, { status: 302, headers: { location: 'https://inner.evil.com/x' } });
    };
    const res = await safeFetchExternalPage('https://store.com/x', { resolver, fetchImpl });
    expect(res).toEqual({ ok: false, kind: 'blocked', reason: 'private_address' });
  });

  it('gives up after the redirect budget', async () => {
    const fetchImpl: typeof fetch = async (input) =>
      new Response(null, { status: 302, headers: { location: `${String(input)}/again` } });
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      fetchImpl,
      maxRedirects: 2,
    });
    expect(res).toEqual({ ok: false, kind: 'too_many_redirects' });
  });

  it('follows a VALID redirect and revalidates the hop', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://store.com/x') {
        return new Response(null, { status: 301, headers: { location: '/products/dress' } });
      }
      expect(url).toBe('https://store.com/products/dress');
      return htmlResponse('landed');
    };
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.url).toBe('https://store.com/products/dress');
      expect(res.body).toBe('landed');
    }
  });

  it('enforces the size cap from content-length', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      maxBytes: 10,
      fetchImpl: async () =>
        htmlResponse('x'.repeat(50), { headers: { 'content-length': '50' } }),
    });
    expect(res).toEqual({ ok: false, kind: 'too_large' });
  });

  it('enforces the size cap mid-stream when content-length lies', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      maxBytes: 10,
      fetchImpl: async () => new Response('x'.repeat(1000), { status: 200 }),
    });
    expect(res).toEqual({ ok: false, kind: 'too_large' });
  });

  it('reports HTTP errors as typed failures (never throws)', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      fetchImpl: async () => new Response('blocked', { status: 403 }),
    });
    expect(res).toEqual({ ok: false, kind: 'http_error', status: 403 });
  });

  it('reports network failures as typed failures (never throws)', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(res).toMatchObject({ ok: false, kind: 'network_error' });
  });

  it('times out hung fetches (never a hang)', async () => {
    const res = await safeFetchExternalPage('https://store.com/x', {
      resolver: publicResolver,
      timeoutMs: 50,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(res).toMatchObject({ ok: false, kind: 'network_error' });
  });
});
