import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { rejectDiscoveredCompany } from '@/lib/discovery/supervised-promotion';
import { recordAdminAction } from '@/lib/admin/audit-log';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

/** POST /api/admin/discovery/[id]/reject — requires a real reason, same
 *  "explicit confirmation server-side, not just client-hidden" requirement
 *  as every other destructive/state-changing admin action. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let admin;
  try {
    admin = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  let body: { reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required to reject a discovery candidate.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  // A failed lookup (e.g. the staging table is absent) is a 500, not "not found".
  let before: { pipeline_stage: string } | null;
  try {
    before = must(
      await db.from('supply_discovered_companies').select('pipeline_stage').eq('id', params.id).maybeSingle(),
      'supply_discovered_companies'
    ).data;
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!before) {
    return NextResponse.json({ error: 'Discovered company not found.' }, { status: 404 });
  }

  const result = await rejectDiscoveredCompany(params.id, reason);

  await recordAdminAction({
    adminId: admin.user.id,
    adminEmail: admin.adminEmail,
    action: 'c6_reject',
    targetType: 'discovered_company',
    targetId: params.id,
    beforeState: { pipeline_stage: before.pipeline_stage },
    afterState: result.rejected ? { pipeline_stage: 'rejected' } : { error: result.error },
    reason,
  });

  if (!result.rejected) {
    return NextResponse.json({ error: result.error ?? 'Rejection failed.' }, { status: 500 });
  }

  return NextResponse.json({ rejected: true });
}
