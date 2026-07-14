/**
 * Local-first anonymous session (ARCHITECTURE §1 auth decision, spec A2).
 *
 * - Signed httpOnly cookie `hemline_session` = `<uuid>.<hmac>` → users row.
 * - The client may also present its localStorage UUID via the
 *   `x-hemline-user-id` header (spec A2: client-minted UUID); a valid UUID is
 *   adopted (row created if absent) and the signed cookie is set in response.
 * - Cookie wins over header. GET /api/session mints when neither is present.
 *
 * No passwords/OAuth anywhere; magic-link merge is a documented later upgrade.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextResponse } from 'next/server';
import type { Db } from '@hemline/db';
import { createUser, userExists } from '@hemline/db';

export const SESSION_COOKIE = 'hemline_session';
export const USER_ID_HEADER = 'x-hemline-user-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string {
  return process.env.SESSION_SECRET ?? 'hemline-dev-secret-do-not-use-in-prod';
}

export function signUserId(userId: string): string {
  const mac = createHmac('sha256', secret()).update(userId).digest('hex').slice(0, 32);
  return `${userId}.${mac}`;
}

export function verifySessionValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(userId).digest('hex').slice(0, 32);
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return UUID_RE.test(userId) ? userId : null;
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export interface SessionResolution {
  userId: string;
  /** true when a new users row (or new cookie) should be attached to the response */
  isNew: boolean;
}

/**
 * Resolve the caller's user id (cookie → header UUID → null).
 * Does not create anything — see `ensureSessionUser`.
 */
export function resolveUserId(req: Request): string | null {
  const fromCookie = verifySessionValue(cookieValue(req, SESSION_COOKIE));
  if (fromCookie) return fromCookie;
  const fromHeader = req.headers.get(USER_ID_HEADER);
  if (fromHeader && UUID_RE.test(fromHeader)) return fromHeader.toLowerCase();
  return null;
}

/**
 * Resolve or mint the session user, creating the users row when missing.
 * Returns the id plus whether the response should (re)set the cookie.
 */
export function ensureSessionUser(req: Request, db: Db): SessionResolution {
  const fromCookie = verifySessionValue(cookieValue(req, SESSION_COOKIE));
  if (fromCookie) {
    if (!userExists(db, fromCookie)) createUser(db, fromCookie);
    return { userId: fromCookie, isNew: false };
  }
  const fromHeader = req.headers.get(USER_ID_HEADER);
  if (fromHeader && UUID_RE.test(fromHeader)) {
    const id = fromHeader.toLowerCase();
    if (!userExists(db, id)) createUser(db, id);
    return { userId: id, isNew: true }; // set cookie so subsequent calls don't need the header
  }
  const id = randomUUID();
  createUser(db, id);
  return { userId: id, isNew: true };
}

/** Require an existing session — 401 when absent (routes that never mint). */
export function requireUserId(req: Request, db: Db): string | null {
  const id = resolveUserId(req);
  if (!id) return null;
  if (!userExists(db, id)) createUser(db, id); // local-first: adopt the client UUID
  return id;
}

/**
 * Best-effort client IP for per-IP rate limiting of GUESTS (no session yet).
 *
 * Trust model on Fly.io: the edge proxy sets `Fly-Client-IP` to the real client
 * address — a value the client CANNOT forge, because Fly overwrites it at the
 * edge. `X-Forwarded-For` is different: a client may send its own XFF and Fly
 * *appends* the real hop, so the LEFTMOST entries are attacker-controlled and
 * only the RIGHTMOST (the hop added by the trusted proxy) is meaningful. We
 * therefore prefer Fly-Client-IP, then fall back to the rightmost XFF entry,
 * then x-real-ip. A naive `xff.split(',')[0]` would trust a spoofable value and
 * let one abuser masquerade as unlimited distinct IPs — do not do that.
 */
export function clientIp(req: Request): string {
  const fly = req.headers.get('fly-client-ip');
  if (fly?.trim()) return fly.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]; // rightmost = trusted hop
  }
  const real = req.headers.get('x-real-ip');
  if (real?.trim()) return real.trim();
  return 'unknown';
}

/**
 * Rate-limit key for a request: the session user when present, else `ip:<addr>`
 * so guests are throttled PER-IP rather than sharing one global guest bucket.
 */
export function rateLimitKey(req: Request): string {
  return resolveUserId(req) ?? `ip:${clientIp(req)}`;
}

export function attachSessionCookie(res: NextResponse, userId: string): void {
  res.cookies.set(SESSION_COOKIE, signUserId(userId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1y — local-first profile persistence
  });
}
