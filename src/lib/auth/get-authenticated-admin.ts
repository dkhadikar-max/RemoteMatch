import { NextRequest } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  getAuthenticatedUser,
  UnauthenticatedError,
  UnverifiedAccountError,
  ServiceUnavailableError,
} from './get-authenticated-user';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export { UnauthenticatedError, UnverifiedAccountError, ServiceUnavailableError };

/**
 * A real, verified RemoteMatch account — but not an admin. Deliberately
 * distinct from UnverifiedAccountError: this caller is a genuine, verified
 * product user; they're simply not authorized for the admin console. Mapped
 * to 403 with its own message (src/lib/auth/api-error.ts) so the two 403
 * cases are never confused with each other in logs or in the UI.
 */
export class AdminForbiddenError extends Error {
  constructor() {
    super('admin_forbidden');
    this.name = 'AdminForbiddenError';
  }
}

export interface AuthenticatedAdmin {
  user: User;
  supabase: SupabaseClient;
  adminEmail: string;
}

/**
 * The admin console's sole server-side authorization boundary. Layered
 * directly on top of getAuthenticatedUser() (never reimplemented) — every
 * admin request must FIRST pass the exact same identity check every regular
 * RemoteMatch API route already enforces (real, non-anonymous, verified
 * Supabase session), THEN additionally prove active `admin_users`
 * membership via the service-role client (a table with zero RLS policy
 * granting any client-side access — see migration 029 — so this check can
 * only ever be performed server-side, never bypassed from the browser).
 *
 * Throws (never returns a caller that fails any check):
 *   - Whatever getAuthenticatedUser() throws (Unauthenticated/Unverified/
 *     ServiceUnavailable) for a caller who isn't even a valid verified user.
 *   - AdminForbiddenError for a verified, real user who is not an active
 *     admin (no row, or `revoked_at` set).
 *   - ServiceUnavailableError if the admin client itself isn't configured.
 *
 * Every route under src/app/api/admin/** must call this before touching
 * any admin data — there is no other enforcement layer. Middleware's own
 * admin_users read (src/middleware.ts) is explicitly UX-only, exactly like
 * its existing onboarding-status read; this function is the real gate.
 */
export async function getAuthenticatedAdmin(req?: NextRequest): Promise<AuthenticatedAdmin> {
  const { user, supabase } = await getAuthenticatedUser(req);

  const admin = getSupabaseAdminClient();
  if (!admin) {
    throw new ServiceUnavailableError();
  }

  const { data: adminRow } = await admin
    .from('admin_users')
    .select('email, revoked_at')
    .eq('id', user.id)
    .is('revoked_at', null)
    .maybeSingle();

  if (!adminRow) {
    throw new AdminForbiddenError();
  }

  return { user, supabase, adminEmail: adminRow.email };
}
