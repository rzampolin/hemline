/**
 * GET /api/session — mints anonymous user + cookie on first hit → UserProfile.
 * docs/ARCHITECTURE.md §4.7. 501 stub showing the response envelope pattern.
 * TODO(backend-eng): signed httpOnly cookie (SESSION_SECRET) → users row.
 */
import { NextResponse } from 'next/server';
import type { ApiResponse, UserProfile } from '@hemline/contracts';

export async function GET() {
  const body: ApiResponse<UserProfile> = {
    ok: false,
    error: {
      code: 'not_implemented',
      message: 'backend-eng: implement session minting — docs/ARCHITECTURE.md §4.7',
    },
  };
  return NextResponse.json(body, { status: 501 });
}
