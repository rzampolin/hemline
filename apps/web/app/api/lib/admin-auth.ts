/**
 * Admin auth (spec G1: "env-var basic auth is fine").
 * Set ADMIN_BASIC_AUTH="user:pass" to require HTTP Basic on /api/admin/*;
 * unset: open in local dev/demo (console warning once), but DENIED in
 * production — a deployed app must never expose open admin endpoints
 * (deploy hardening, 2026-07-08; DEPLOY.md sets the secret before launch).
 */
let warned = false;

export function checkAdminAuth(req: Request): boolean {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      if (!warned) {
        console.error(
          '[api:admin] ADMIN_BASIC_AUTH is not set — admin endpoints are DISABLED in production. ' +
            'Set it: fly secrets set ADMIN_BASIC_AUTH="user:pass"',
        );
        warned = true;
      }
      return false;
    }
    if (!warned) {
      console.warn('[api:admin] ADMIN_BASIC_AUTH not set — admin endpoints are open (dev mode)');
      warned = true;
    }
    return true;
  }
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded === expected;
  } catch {
    return false;
  }
}
