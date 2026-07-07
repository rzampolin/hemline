import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
