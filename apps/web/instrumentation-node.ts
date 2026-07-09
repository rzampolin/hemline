/**
 * Node-runtime server-startup guard — the body of the Next instrumentation
 * hook, dynamically imported from instrumentation.ts inside an
 * `if (process.env.NEXT_RUNTIME === 'nodejs')` BLOCK. It must live in its
 * own module: once a middleware exists (admin dashboard, 2026-07-09) Next
 * also compiles instrumentation for the Edge runtime, and the
 * @hemline/matching/embedder import below would drag node:child_process
 * into that bundle unless webpack can dead-code the whole branch away
 * (the documented Next pattern; an early `return` does NOT stop webpack
 * from collecting the import).
 *
 * Runs once when the server boots, including the standalone server.js in
 * the Docker image.
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

  // ── eager ML sidecar warmup (the prod container sets HEMLINE_ML_EAGER=1) ──
  // Fire-and-forget: the server accepts traffic immediately; /api/health
  // reports ml.state warming → ready and ml.sidecarAvailable flips true when
  // the model is resident. find-similar requests issued during the load queue
  // behind it (90s bridge timeout covers it) or fall back to attributes on
  // failure. Never enabled in dev — a 5–20s torch load per restart would be rude.
  if (process.env.HEMLINE_ML_EAGER === '1') {
    const { isEmbedderAvailable, warmSharedEmbedder } = await import(
      '@hemline/matching/embedder'
    );
    if (!isEmbedderAvailable()) {
      console.warn(
        '[startup] HEMLINE_ML_EAGER=1 but the ml sidecar is not installed — ' +
          'visual probe search will use the attribute fallback',
      );
    } else {
      const t0 = Date.now();
      console.log(
        '[startup] warming FashionSigLIP sidecar (5-20s model load; /api/health ml.state flips to "ready")',
      );
      void warmSharedEmbedder().then((ready) => {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (ready) console.log(`[startup] ml sidecar ready in ${secs}s`);
        else
          console.error(
            `[startup] ml sidecar warmup FAILED after ${secs}s — probe embedding disabled, ` +
              'attribute fallback active (set HEMLINE_ML_DEBUG=1 for embed.py stderr)',
          );
      });
    }
  }
}
