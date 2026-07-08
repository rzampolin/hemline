/**
 * Server-startup guard (Next 15 instrumentation hook — runs once when the
 * server boots, including the standalone server.js in the Docker image).
 *
 * Production refuses to start with a missing/default SESSION_SECRET: the
 * session cookie is HMAC-signed with it, so a known secret means forgeable
 * sessions. Dev/test keep the permissive fallback (local-first demo story).
 *
 * The docker/start.mjs supervisor performs the same check before spawning
 * (belt and braces: clearer error, no half-started container).
 */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-32-chars-minimum-random', // .env.example placeholder
  'hemline-dev-secret-do-not-use-in-prod', // session.ts dev fallback
]);

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;

  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < 32) {
    console.error(
      '[startup] FATAL: SESSION_SECRET is missing, a known placeholder, or shorter than 32 chars. ' +
        'Refusing to serve in production. Generate one:  openssl rand -hex 32  ' +
        'then:  fly secrets set SESSION_SECRET=<value>',
    );
    process.exit(1);
  }

  if (!process.env.ADMIN_BASIC_AUTH) {
    // Not fatal — admin routes deny-all without it (lib/admin-auth.ts) — but loud.
    console.warn(
      '[startup] ADMIN_BASIC_AUTH not set: /api/admin/* will return 401 for everyone. ' +
        'Set it: fly secrets set ADMIN_BASIC_AUTH="user:pass"',
    );
  }
}
