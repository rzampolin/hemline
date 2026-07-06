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
  ],
  // Native module — must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
