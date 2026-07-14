/**
 * /admin — founder-facing ops dashboard (2026-07-09).
 *
 * Server shell only; all data comes from the existing /api/admin/* endpoints
 * via the client dashboard (60s auto-refresh). Auth lives in
 * apps/web/middleware.ts (HTTP Basic, same env gate as the API routes).
 * Desktop-first by design — this is the one internal page in the app.
 */
import type { Metadata } from 'next';
import { AdminDashboard } from './dashboard';

export const metadata: Metadata = {
  title: 'Soline — Admin',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminDashboard />;
}
