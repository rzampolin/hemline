/**
 * /admin page basic-auth middleware (admin dashboard, 2026-07-09).
 * Same env semantics as app/api/lib/admin-auth.ts, plus the browser-facing
 * WWW-Authenticate challenge (the API's bare 401 envelope never prompts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../../../middleware';

const req = (headers: Record<string, string> = {}) =>
  new NextRequest('http://test/admin', { headers });

const basic = (creds: string) => ({
  authorization: `Basic ${Buffer.from(creds).toString('base64')}`,
});

afterEach(() => {
  delete process.env.ADMIN_BASIC_AUTH;
  vi.unstubAllEnvs();
});

describe('/admin middleware', () => {
  it('only matches /admin paths (never the public app)', () => {
    expect(config.matcher).toEqual(['/admin', '/admin/:path*']);
  });

  it('challenges with WWW-Authenticate when creds are missing or wrong', () => {
    process.env.ADMIN_BASIC_AUTH = 'op:secret';
    for (const r of [req(), req(basic('op:wrong')), req({ authorization: 'Basic %%%' })]) {
      const res = middleware(r);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    }
  });

  it('passes through with correct credentials', () => {
    process.env.ADMIN_BASIC_AUTH = 'op:secret';
    const res = middleware(req(basic('op:secret')));
    expect(res.status).toBe(200); // NextResponse.next()
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('is open in dev when ADMIN_BASIC_AUTH is unset', () => {
    expect(middleware(req()).status).toBe(200);
  });

  it('is DENIED (no challenge) in production when ADMIN_BASIC_AUTH is unset', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = middleware(req());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});
