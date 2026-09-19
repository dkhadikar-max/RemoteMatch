import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { recordAdminAction } from '@/lib/admin/audit-log';
import { must, mustCount } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

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

  // A failed count must not be read as "only one admin left" (which would
  // report a database error as a lockout-protection 409), nor a failed
  // lookup as "Admin not found".
  let activeCount: number;
  let before: { email: string; revoked_at: string | null } | null;
  try {
    activeCount = mustCount(
      await db.from('admin_users').select('id', { count: 'exact', head: true }).is('revoked_at', null),
      'admin_users.active'
    );
    before = must(await db.from('admin_users').select('email, revoked_at').eq('id', params.id).maybeSingle(), 'admin_users').data;
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  if (activeCount <= 1) {
    return NextResponse.json({ error: 'Cannot revoke the last remaining active admin.' }, { status: 409 });
  }
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
