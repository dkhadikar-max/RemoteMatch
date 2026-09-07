import { NextResponse } from 'next/server';
import {
  UnauthenticatedError,
  UnverifiedAccountError,
  ServiceUnavailableError,
} from '@/lib/auth/get-authenticated-user';

/**
 * Central mapping from auth/service failures to HTTP responses, so every
 * protected route rejects unauthenticated/unverified/misconfigured-backend
 * cases identically instead of each route reimplementing (and potentially
 * getting wrong) that mapping.
 */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized: sign-in required.' }, { status: 401 });
  }
  if (err instanceof UnverifiedAccountError) {
    // A real session exists but doesn't meet the account invariant
    // (anonymous, or email not yet confirmed) — 403, not 401, since the
    // caller IS authenticated, just not sufficiently.
    return NextResponse.json(
      { error: 'Forbidden: a verified account is required.' },
      { status: 403 }
    );
  }
  if (err instanceof ServiceUnavailableError) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable: server storage is not configured.' },
      { status: 503 }
    );
  }
  return null;
}
