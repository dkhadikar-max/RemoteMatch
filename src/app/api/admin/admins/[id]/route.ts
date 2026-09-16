import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { recordAdminAction } from '@/lib/admin/audit-log';

/**
 * DELETE — soft-revoke (sets revoked_at, never deletes the row — the
 * audit trail of who was ever an admin must survive). Refuses to revoke
 * the LAST remaining active admin, so this console can never lock every
 * admin out of itself by mistake — that specific case would need a direct
 * dashboard action, same as bootstrapping the very first admin row.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  let revoker;
  try {
    revoker = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { count: activeCount } = await db.from('admin_users').select('id', { count: 'exact', head: true }).is('revoked_at', null);
  if ((activeCount ?? 0) <= 1) {
    return NextResponse.json({ error: 'Cannot revoke the last remaining active admin.' }, { status: 409 });
  }

  const { data: before } = await db.from('admin_users').select('email, revoked_at').eq('id', params.id).maybeSingle();
  if (!before) return NextResponse.json({ error: 'Admin not found.' }, { status: 404 });

  const { error } = await db.from('admin_users').update({ revoked_at: new Date().toISOString() }).eq('id', params.id);

  await recordAdminAction({
    adminId: revoker.user.id,
    adminEmail: revoker.adminEmail,
    action: 'admin_revoke',
    targetType: 'admin_user',
    targetId: params.id,
    beforeState: { email: before.email, revoked_at: before.revoked_at },
    afterState: error ? { error: error.message } : { revoked_at: 'now' },
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ revoked: true });
}
