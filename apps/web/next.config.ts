import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (docs/decisions-deploy.md).
  // Tracing is rooted at the monorepo root so workspace packages and the
  // hoisted node_modules (better-sqlite3, sharp) land in .next/standalone.
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  // Workspace packages ship raw TS — Next transpiles them in place.
  transpilePackages: [
    '@hemline/contracts',
    '@hemline/ui',
    '@hemline/db',
    '@hemline/matching',
    '@hemline/ai',
    '@hemline/connectors',
    '@hemline/ingest',
  ],
  // Native modules — must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  // Baseline security headers on every response (2026-07-14 security audit).
  // Conservative set that cannot break the app: clickjacking (frame-ancestors
  // + X-Frame-Options), MIME sniffing, referrer leakage, feature access, and
  // HSTS (the app is HTTPS-only behind Fly). A full script/style CSP is
  // deliberately NOT added here — Next's inline runtime needs nonces/hashes to
  // avoid breakage; that is tracked as a follow-up in docs/SECURITY_REVIEW.md.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
