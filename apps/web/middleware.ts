/**
 * HTTP Basic gate for the /admin dashboard PAGE (admin dashboard, 2026-07-09).
 *
 * Same semantics as apps/web/app/api/lib/admin-auth.ts (which guards the
 * /api/admin/* route handlers and cannot run here — middleware is Edge, the
 * helper is Node): ADMIN_BASIC_AUTH="user:pass" required in production,
 * open in local dev when unset. Unlike the API's bare 401 envelope, the page
 * challenge sends WWW-Authenticate so the browser shows its native
 * credentials prompt — no session/login UI (spec G1 "env-var basic auth is
 * fine"). The realm path is /admin, i.e. directory "/", so browsers re-send
 * the cached credentials preemptively on the dashboard's same-origin fetches
 * to /api/admin/*.
 */
import { NextResponse, type NextRequest } from 'next/server';

export const config = { matcher: ['/admin', '/admin/:path*'] };

export function middleware(req: NextRequest) {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) {
    // parity with checkAdminAuth: DENIED in production (never an open admin
    // surface on a deployed app), open in local dev/demo.
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('admin disabled: ADMIN_BASIC_AUTH is not set', { status: 401 });
    }
    return NextResponse.next();
  }
  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      if (atob(header.slice(6)) === expected) return NextResponse.next();
    } catch {
      /* malformed base64 → challenge below */
    }
  }
  return new NextResponse('authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="hemline-admin", charset="UTF-8"' },
  });
}
