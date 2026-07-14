/**
 * SSRF guard for the fit-check's user-supplied URL fetch (2026-07-13).
 *
 * The fit check fetches ARBITRARY user-pasted URLs from the server, so every
 * fetch goes through this module. Defense layers:
 *  1. URL shape: https ONLY, default port only, no credentials in the URL,
 *     hostname must not be localhost/.local/.internal/.home.arpa etc.
 *  2. IP-literal hosts are validated directly against the private/reserved
 *     ranges (IPv4 + IPv6, including IPv4-mapped IPv6).
 *  3. DNS resolution: EVERY address the hostname resolves to must be public
 *     (a single private A record — DNS-rebinding style — rejects the URL).
 *  4. Redirects are followed MANUALLY (max 3 hops) and every hop re-runs
 *     layers 1–3, so a public page can't bounce us into 169.254.169.254.
 *  5. Response body is size-capped mid-stream and the whole request runs
 *     under a hard AbortSignal timeout — never a hang.
 *
 * Everything is dependency-injectable (resolver, fetch) for the test matrix.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Hard cap on a fetched page body (HTML/JSON) — PDPs are well under this. */
export const SAFE_FETCH_MAX_BYTES = 3 * 1024 * 1024;
/** Per-request hard timeout. */
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
/** Max redirect hops followed (each hop is re-validated). */
export const SAFE_FETCH_MAX_REDIRECTS = 3;

const BLOCKED_HOSTNAME_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.intranet|.*\.home\.arpa|metadata\.google\.internal)$/i;

/** Is this IPv4 address (dotted quad) private/reserved? */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata!)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 test
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 bench
  if (a === 198 && b === 51) return true; // 198.51.100/24 test
  if (a === 203 && b === 0) return true; // 203.0.113/24 test
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Is this IP address (v4 or v6) private/reserved/loopback? */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family !== 6) return true; // not an IP at all → unsafe

  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped/translated (::ffff:10.0.0.1, ::ffff:0a00:0001) → check the v4
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true; // hex-mapped v4 — be safe
  if (lower === '::' || lower === '::1') return true; // unspecified / loopback
  const firstGroup = lower.split(':')[0] || '0';
  const first16 = Number.parseInt(firstGroup.padStart(4, '0'), 16);
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first16 & 0xffff) === 0x0064) return true; // 64:ff9b::/96 NAT64 prefix space
  if (first16 === 0x2001 && /^2001:db8/.test(lower)) return true; // doc range
  return false;
}

export type UrlRejection =
  | 'invalid_url'
  | 'not_https'
  | 'blocked_port'
  | 'blocked_credentials'
  | 'blocked_hostname'
  | 'private_address'
  | 'dns_failure';

export type SafeUrlResult = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Validate one URL for server-side fetching: shape checks synchronously, then
 * DNS resolution — every resolved address must be public.
 */
export async function validateExternalUrl(
  raw: string,
  resolver: Resolver = defaultResolver,
): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'blocked_port' };
  if (url.username || url.password) return { ok: false, reason: 'blocked_credentials' };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || BLOCKED_HOSTNAME_RE.test(hostname)) {
    return { ok: false, reason: 'blocked_hostname' };
  }
  if (isIP(hostname) !== 0) {
    return isPrivateAddress(hostname)
      ? { ok: false, reason: 'private_address' }
      : { ok: true, url };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_failure' };
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    return { ok: false, reason: 'private_address' };
  }
  return { ok: true, url };
}

// ── guarded fetch ──────────────────────────────────────────────────────────

export type SafeFetchFailure =
  | { ok: false; kind: 'blocked'; reason: UrlRejection }
  | { ok: false; kind: 'http_error'; status: number }
  | { ok: false; kind: 'too_large' }
  | { ok: false; kind: 'too_many_redirects' }
  | { ok: false; kind: 'network_error'; detail: string };

export type SafeFetchResult =
  | {
      ok: true;
      /** final URL after (validated) redirects */
      url: string;
      status: number;
      contentType: string | null;
      body: string;
    }
  | SafeFetchFailure;

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  userAgent?: string;
}

/** Read the body with the byte cap enforced mid-stream (never buffer 1GB). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | 'too_large'> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? 'too_large' : new TextDecoder().decode(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Fetch a user-supplied URL with the full SSRF guard: validation on the
 * initial URL AND on every redirect hop, manual redirect following, hard
 * timeout, streamed size cap. Never throws — every failure is a typed result.
 */
export async function safeFetchExternalPage(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolver;
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  const userAgent =
    options.userAgent ??
    `SolineBot/1.0 (+${process.env.CRAWLER_CONTACT ?? 'rzampolin15@gmail.com'})`;

  const deadline = AbortSignal.timeout(timeoutMs);
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateExternalUrl(current, resolver);
    if (!validated.ok) return { ok: false, kind: 'blocked', reason: validated.reason };

    let res: Response;
    try {
      res = await fetchImpl(validated.url.toString(), {
        redirect: 'manual',
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
          ...options.headers,
        },
        signal: deadline,
      });
    } catch (err) {
      return {
        ok: false,
        kind: 'network_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      // drain/cancel the redirect body — we never read it
      await res.body?.cancel().catch(() => undefined);
      if (!location) return { ok: false, kind: 'http_error', status: res.status };
      if (hop === maxRedirects) return { ok: false, kind: 'too_many_redirects' };
      try {
        current = new URL(location, validated.url).toString();
      } catch {
        return { ok: false, kind: 'blocked', reason: 'invalid_url' };
      }
      continue; // next hop re-validates (https, hostname, DNS)
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'http_error', status: res.status };
    }

    let body: string | 'too_large';
    try {
      body = await readBodyCapped(res, maxBytes);
    } catch (err) {
      return {
        ok: false,
        kind: 'network_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (body === 'too_large') return { ok: false, kind: 'too_large' };

    return {
      ok: true,
      url: validated.url.toString(),
      status: res.status,
      contentType: res.headers.get('content-type'),
      body,
    };
  }
  return { ok: false, kind: 'too_many_redirects' };
}
