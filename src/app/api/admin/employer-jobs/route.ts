import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

export async function GET(req: NextRequest) {
  try { await getAuthenticatedAdmin(req); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const result = must(await db.from('employer_job_submissions')
      .select('id,company_id,title,employment_type,remote_type,location,status,submitted_at,created_at,companies(legal_name,official_domain,verification_status)', { count: 'exact' })
      .in('status', ['submitted','under_review']).order('submitted_at', { ascending: true, nullsFirst: false }).limit(100), 'employer_job_submissions');
    return NextResponse.json({ jobs: result.data ?? [], total: result.count ?? 0 });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
}

export async function PATCH(req: NextRequest) {
  let admin;
  try { admin = await getAuthenticatedAdmin(req); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 });
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(k => !['submissionId','action','reason'].includes(k)) ||
      typeof body.submissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.submissionId) ||
      !['mark_under_review','approve_publish','reject'].includes(String(body.action)) ||
      typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) {
    return NextResponse.json({ error: 'Provide a valid submissionId, action and review reason.' }, { status: 400 });
  }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  const { data, error } = await db.rpc('review_employer_job_submission', {
    p_submission_id: body.submissionId, p_admin_id: admin.user.id, p_admin_email: admin.adminEmail,
    p_action: body.action, p_reason: body.reason.trim(),
  });
  if (error) {
    console.error('[admin/employer-jobs] review RPC failed', { submissionId: body.submissionId, action: body.action, error: error.message });
    return NextResponse.json({ error: 'Could not complete the review action.' }, { status: 500 });
  }
  const result = (data ?? [])[0] as { ok: boolean; new_status: string | null; opportunity_id: string | null } | undefined;
  if (!result?.ok) return NextResponse.json({ error: 'The vacancy changed or is no longer eligible for this action. Refresh the queue.' }, { status: 409 });
  return NextResponse.json({ ok: true, status: result.new_status, opportunityId: result.opportunity_id });
}
