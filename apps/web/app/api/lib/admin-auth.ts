/**
 * Admin auth (spec G1: "env-var basic auth is fine").
 * Set ADMIN_BASIC_AUTH="user:pass" to require HTTP Basic on /api/admin/*;
 * unset (local dev / demo) → open, with a console warning once.
 */
let warned = false;

export function checkAdminAuth(req: Request): boolean {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) {
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
