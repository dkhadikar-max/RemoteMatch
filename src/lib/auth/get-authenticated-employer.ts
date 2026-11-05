import { NextRequest } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  getAuthenticatedUser,
  UnauthenticatedError,
  UnverifiedAccountError,
  ServiceUnavailableError,
} from './get-authenticated-user';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';

export { UnauthenticatedError, UnverifiedAccountError, ServiceUnavailableError };

/**
 * A real, verified RemoteMatch account — but not an active member of the
 * requested company. Deliberately mapped to 404, not 403 (Phase 1 plan Q7):
 * the caller never learns whether a given company id exists at all, only
 * that they have no access to it. See src/lib/auth/api-error.ts.
 */
export class EmployerForbiddenError extends Error {
  constructor() {
    super('employer_forbidden');
    this.name = 'EmployerForbiddenError';
  }
}

export type CompanyMemberRole = 'owner' | 'admin' | 'member';

export interface AuthenticatedEmployer {
  user: User;
  supabase: SupabaseClient;
  companyId: string;
  role: CompanyMemberRole;
}

/**
 * The employer-facing authorization boundary for a single company. Layered
 * directly on top of getAuthenticatedUser() — every employer request must
 * first pass the same identity check every RemoteMatch API route enforces
 * (real, non-anonymous, verified Supabase session), then additionally prove
 * active `company_members` membership in THIS company, via the service-role
 * client (company_members has zero RLS policy granting any client-side
 * access — migration 044 — so this check can only ever run server-side).
 *
 * `companyId` must come from the route's own path segment (e.g.
 * `/api/employer/companies/[id]`), never from the request body — a caller
 * could otherwise claim membership in a company they don't belong to simply
 * by naming a different id in the payload.
 *
 * A profile may belong to more than one company (Phase 1 plan Q4), so —
 * unlike getAuthenticatedAdmin(), which has exactly one admin scope — this
 * function takes the target company explicitly rather than resolving a
 * single implicit scope for the caller.
 *
 * Throws (never returns a caller that fails any check):
 *   - Whatever getAuthenticatedUser() throws, for a caller who isn't even a
 *     valid verified user.
 *   - EmployerForbiddenError for a verified, real user with no active
 *     membership row for this company (no row, wrong company, or
 *     `status = 'revoked'`).
 *   - ServiceUnavailableError if the admin client itself isn't configured.
 *   - Whatever QueryError must() throws for a genuine database/query
 *     failure on the membership lookup itself (e.g. an invalid `companyId`
 *     that isn't a well-formed uuid) — this is deliberately NOT folded into
 *     EmployerForbiddenError (2026-11-05 review finding fix): a real
 *     caller sees a 404 identical to a non-member, but a DB failure is a
 *     distinct, controlled 500 via authErrorResponse()'s default fallthrough
 *     in every route that calls this function, never silently reported as
 *     "not found".
 */
export async function getAuthenticatedEmployer(
  req: NextRequest | undefined,
  companyId: string
): Promise<AuthenticatedEmployer> {
  const { user, supabase } = await getAuthenticatedUser(req);

  const admin = getSupabaseAdminClient();
  if (!admin) {
    throw new ServiceUnavailableError();
  }

  const { data: member } = must(
    await admin
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('profile_id', user.id)
      .eq('status', 'active')
      .maybeSingle(),
    'company_members'
  );

  if (!member) {
    throw new EmployerForbiddenError();
  }

  return { user, supabase, companyId, role: member.role as CompanyMemberRole };
}
