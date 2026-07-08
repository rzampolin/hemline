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
};

export default nextConfig;
