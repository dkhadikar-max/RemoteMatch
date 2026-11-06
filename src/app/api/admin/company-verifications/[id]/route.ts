import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import type { AdminAuditAction } from '@/lib/admin/audit-log';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

/** GET — the full company record + its company_members rows, so the admin
 *  sees the submitted representative fields alongside the registration. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  try {
    const companyRes = must(
      await admin.from('companies').select('*').eq('id', params.id).maybeSingle(),
      'companies'
    );
    if (!companyRes.data) return NextResponse.json({ error: 'Company not found.' }, { status: 404 });

    const membersRes = must(
      await admin
        .from('company_members')
        .select('id, profile_id, role, representative_name, representative_designation, representative_relationship, status, created_at')
        .eq('company_id', params.id)
        .order('created_at', { ascending: true }),
      'company_members'
    );

    return NextResponse.json({ company: companyRes.data, members: membersRes.data ?? [] });
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

type VerificationAction = 'mark_under_review' | 'verify' | 'reject' | 'suspend' | 'reinstate';

export const TRANSITIONS: Record<VerificationAction, { from: string[]; to: string }> = {
  mark_under_review: { from: ['pending'], to: 'under_review' },
  verify: { from: ['pending', 'under_review'], to: 'verified' },
  reject: { from: ['pending', 'under_review'], to: 'rejected' },
  suspend: { from: ['verified'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'verified' },
};

const AUDIT_ACTION: Record<VerificationAction, AdminAuditAction> = {
  mark_under_review: 'company_mark_under_review',
  verify: 'company_verify',
  reject: 'company_reject',
  suspend: 'company_suspend',
  reinstate: 'company_reinstate',
};

/**
 * PATCH — the sanctioned verification-status transitions (Phase 1 plan §2).
 * `mark_under_review` is the one explicit, admin-initiated transition for
 * Q5 (never automatic on a mere GET). Every transition requires a non-empty
 * `reason` and is audit-logged with before/after state, mirroring
 * `opportunity_force_expire`'s shape exactly.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let adminAuth;
  try {
    adminAuth = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  // Defensive body-shape validation (2026-11-06 review finding #6 fix): a
  // body of `null`, a non-object, or a non-string `reason` previously
  // reached `.trim()` below and would have thrown a TypeError (unhandled
  // -> 500) rather than a controlled 400. `typeof null === 'object'`, so
  // the null check is required separately from the typeof check.
  if (rawBody === null || typeof rawBody !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const body = rawBody as { action?: unknown; reason?: unknown };
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string.' }, { status: 400 });
  }

  // Object.hasOwn(), not `action in TRANSITIONS` (2026-11-06 review finding
  // fix): `in` also matches inherited Object.prototype properties
  // ('toString', 'constructor', '__proto__', ...), which would then pass
  // this check and make `TRANSITIONS[action]` below resolve to an
  // inherited function/object rather than undefined — `transition.from`
  // would throw a TypeError (unhandled -> 500) instead of being rejected
  // here with a clean 400.
  const rawAction = body.action;
  if (!rawAction || typeof rawAction !== 'string' || !Object.hasOwn(TRANSITIONS, rawAction)) {
    return NextResponse.json(
      { error: `action must be one of: ${Object.keys(TRANSITIONS).join(', ')}` },
      { status: 400 }
    );
  }
  const action = rawAction as VerificationAction;
  const reason = ((body.reason as string | undefined) ?? '').trim();
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required for this action.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  let before: { verification_status: string } | null;
  try {
    before = must(
      await db.from('companies').select('verification_status').eq('id', params.id).maybeSingle(),
      'companies'
    ).data;
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  if (!before) return NextResponse.json({ error: 'Company not found.' }, { status: 404 });

  const transition = TRANSITIONS[action];
  if (!transition.from.includes(before.verification_status)) {
    return NextResponse.json(
      {
        error: `Cannot ${action}: company is '${before.verification_status}', expected one of [${transition.from.join(', ')}].`,
      },
      { status: 409 }
    );
  }

  // Atomic compare-and-swap + audit write (2026-11-06 review finding fix,
  // round 2): raised twice on PR #49 — checking recordAdminAction()'s
  // result (the round-1 fix) made a failed audit write VISIBLE but did not
  // make it ATOMIC with the status transition. `transition_company_
  // verification_with_audit()` (migration 047) does both writes in one
  // Postgres transaction: either both the `companies` UPDATE and the
  // `admin_audit_log` INSERT commit, or neither does. `transitioned: false`
  // means the compare-and-swap lost the race (someone else changed
  // verification_status between our read and this call) — reported as a
  // 409, with no partial write of any kind, exactly like the old code's
  // zero-row case, just without a window where the status could change but
  // the audit row could independently fail.
  const { data: rpcRows, error: rpcError } = await db.rpc('transition_company_verification_with_audit', {
    p_company_id: params.id,
    p_expected_status: before.verification_status,
    p_new_status: transition.to,
    p_reviewed_by: adminAuth.adminEmail,
    p_reason: reason,
    p_admin_id: adminAuth.user.id,
    p_admin_email: adminAuth.adminEmail,
    p_audit_action: AUDIT_ACTION[action],
  });

  if (rpcError) {
    console.error('[admin/company-verifications] transition_company_verification_with_audit RPC failed', {
      companyId: params.id, action, error: rpcError.message,
    });
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const result = (rpcRows ?? [])[0] as { transitioned: boolean; verification_status: string | null } | undefined;
  if (!result?.transitioned) {
    return NextResponse.json(
      { error: `Company verification status changed since it was read (was '${before.verification_status}'); please retry.` },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, verificationStatus: result.verification_status });
}
