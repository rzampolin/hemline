/**
 * Canonical public origin (ops, 2026-07-13 — custom-domain prep, docs/DOMAIN.md).
 *
 * Single source of truth for the app's absolute URL: NEXT_PUBLIC_APP_URL with
 * the fly.dev fallback. Anywhere an absolute URL is needed (metadataBase /
 * OG tags, future sitemap/robots/emails) must read APP_URL — never hardcode
 * a hostname.
 *
 * NEXT_PUBLIC_* is inlined at BUILD time for client bundles (set via the
 * Dockerfile ARG + fly.toml [build.args]); server components additionally see
 * the runtime env the runner stage sets. Changing domains = one value in
 * fly.toml + `fly deploy`.
 */
export const APP_URL: string = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://hemline.fly.dev').replace(/\/+$/, '');
