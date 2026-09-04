import { NextResponse } from 'next/server';
import { UnauthenticatedError, ServiceUnavailableError } from '@/lib/auth/get-authenticated-user';

/**
 * Central mapping from auth/service failures to HTTP responses, so every
 * protected route rejects unauthenticated and misconfigured-backend cases
 * identically instead of each route reimplementing (and potentially
 * getting wrong) that mapping.
 */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized: sign-in required.' }, { status: 401 });
  }
  if (err instanceof ServiceUnavailableError) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable: server storage is not configured.' },
      { status: 503 }
    );
  }
  return null;
}
