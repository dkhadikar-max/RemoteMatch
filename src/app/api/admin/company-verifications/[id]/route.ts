import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { recordAdminAction, type AdminAuditAction } from '@/lib/admin/audit-log';
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

const TRANSITIONS: Record<VerificationAction, { from: string[]; to: string }> = {
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

  let body: { action?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const action = body.action as VerificationAction | undefined;
  if (!action || !(action in TRANSITIONS)) {
    return NextResponse.json(
      { error: `action must be one of: ${Object.keys(TRANSITIONS).join(', ')}` },
      { status: 400 }
    );
  }
  const reason = (body.reason ?? '').trim();
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

  // Compare-and-swap (2026-11-05 review finding fix): the `.eq('verification_status', ...)`
  // below makes the write conditional on the EXACT value just read above, not just the id.
  // Without it, two concurrent requests could both pass the `transition.from.includes(...)`
  // guard against the same stale read, both unconditionally overwrite the row, and both
  // report success with contradictory audit_log rows. `.select()` on the update returns the
  // updated row(s) — zero rows means the condition didn't match (someone else changed
  // verification_status between our read and this write), which is reported as a 409 and
  // deliberately never reaches recordAdminAction(): a lost race never gets logged as if its
  // transition actually happened.
  const { data: updatedRows, error: updateErr } = await db
    .from('companies')
    .update({
      verification_status: transition.to,
      verification_reviewed_at: new Date().toISOString(),
      verification_reviewed_by: adminAuth.adminEmail,
      verification_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('verification_status', before.verification_status)
    .select('verification_status');

  if (updateErr) {
    await recordAdminAction({
      adminId: adminAuth.user.id,
      adminEmail: adminAuth.adminEmail,
      action: AUDIT_ACTION[action],
      targetType: 'company',
      targetId: params.id,
      beforeState: before,
      afterState: { error: updateErr.message },
      reason,
    });
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  if ((updatedRows ?? []).length === 0) {
    return NextResponse.json(
      { error: `Company verification status changed since it was read (was '${before.verification_status}'); please retry.` },
      { status: 409 }
    );
  }

  await recordAdminAction({
    adminId: adminAuth.user.id,
    adminEmail: adminAuth.adminEmail,
    action: AUDIT_ACTION[action],
    targetType: 'company',
    targetId: params.id,
    beforeState: before,
    afterState: { verification_status: transition.to },
    reason,
  });

  return NextResponse.json({ ok: true, verificationStatus: transition.to });
}
