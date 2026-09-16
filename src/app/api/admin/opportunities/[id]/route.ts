import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { recordAdminAction } from '@/lib/admin/audit-log';

/** GET — the full opportunity record, for safe inspection. */
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

  const { data, error } = await admin.from('opportunities').select('*').eq('id', params.id).single();
  if (error || !data) return NextResponse.json({ error: 'Opportunity not found.' }, { status: 404 });

  return NextResponse.json({ opportunity: data });
}

/**
 * PATCH — the ONE sanctioned mutation: `force_expire`. Deliberately no
 * free-form field editing (out of scope per the plan's explicit scope
 * boundary). Requires a real reason; server-independently re-validates it
 * rather than trusting the client's confirmation dialog alone, and
 * audit-logs the real before/after `status`.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let admin;
  try {
    admin = await getAuthenticatedAdmin(req);
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

  if (body.action !== 'force_expire') {
    return NextResponse.json({ error: "Only the 'force_expire' action is supported." }, { status: 400 });
  }
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required to force-expire an opportunity.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data: before } = await db.from('opportunities').select('status, is_permanently_removed').eq('id', params.id).maybeSingle();
  if (!before) return NextResponse.json({ error: 'Opportunity not found.' }, { status: 404 });

  const { error: updateErr } = await db
    .from('opportunities')
    .update({ status: 'expired', is_permanently_removed: true })
    .eq('id', params.id);

  await recordAdminAction({
    adminId: admin.user.id,
    adminEmail: admin.adminEmail,
    action: 'opportunity_force_expire',
    targetType: 'opportunity',
    targetId: params.id,
    beforeState: before,
    afterState: updateErr ? { error: updateErr.message } : { status: 'expired', is_permanently_removed: true },
    reason,
  });

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
