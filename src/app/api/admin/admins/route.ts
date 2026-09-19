import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { recordAdminAction } from '@/lib/admin/audit-log';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

/** GET — list every admin, active and revoked (for a full audit trail). */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data, error } = await admin
    .from('admin_users')
    .select('id, email, granted_by, granted_at, revoked_at, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ admins: data ?? [] });
}

/**
 * POST — grant admin access to an EXISTING RemoteMatch account, identified
 * by email (never by trusting a client-supplied user id directly — the
 * target's real auth.users id is resolved server-side from that email).
 * Requires the target account to already exist as a real, verified
 * RemoteMatch user; this route never creates a new account.
 */
export async function POST(req: NextRequest) {
  let granter;
  try {
    granter = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'An email is required.' }, { status: 400 });

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  let targetProfile: { id: string; email: string } | null;
  try {
    targetProfile = must(await db.from('profiles').select('id, email').ilike('email', email).maybeSingle(), 'profiles').data;
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  if (!targetProfile) {
    return NextResponse.json({ error: 'No RemoteMatch account exists with that email.' }, { status: 404 });
  }

  const { error: upsertErr } = await db
    .from('admin_users')
    .upsert(
      { id: targetProfile.id, email: targetProfile.email, granted_by: granter.adminEmail, granted_at: new Date().toISOString(), revoked_at: null },
      { onConflict: 'id' }
    );

  await recordAdminAction({
    adminId: granter.user.id,
    adminEmail: granter.adminEmail,
    action: 'admin_grant',
    targetType: 'admin_user',
    targetId: targetProfile.id,
    afterState: { email: targetProfile.email },
    reason: upsertErr ? `grant failed: ${upsertErr.message}` : null,
  });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  return NextResponse.json({ granted: true, id: targetProfile.id });
}
