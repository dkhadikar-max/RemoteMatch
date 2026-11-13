import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedEmployer } from '@/lib/auth/get-authenticated-employer';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const STATUSES = ['reviewing','shortlisted','interviewing','offered','rejected','hired'] as const;
const EXPECTED_STATUSES = ['submitted','reviewing','shortlisted','interviewing','offered','rejected','hired','withdrawn','offer_declined'] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try { await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data, error } = await db.from('employer_job_applications')
    .select('id,submission_id,opportunity_id,cover_note,status,submitted_at,updated_at,employer_job_submissions!inner(title),profiles!employer_job_applications_candidate_profile_id_fkey(id,email,full_name,headline,avatar_url,resume_file_url,linkedin_url)')
    .eq('employer_job_submissions.company_id', params.id)
    .order('submitted_at', { ascending: false });
  if (error) {
    console.error('[employer/applications] list failed', { companyId: params.id, error: error.message });
    return NextResponse.json({ error: 'Could not load applications.' }, { status: 500 });
  }
  return NextResponse.json({ applications: data ?? [] });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let employer;
  try { employer = await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  if (employer.role === 'member') {
    return NextResponse.json({ error: 'Only company owners and admins can update applicant status.' }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { applicationId, expectedStatus, status, reasonCode, idempotencyKey } = body as Record<string, unknown>;
  if (typeof applicationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(applicationId) ||
      typeof expectedStatus !== 'string' || !(EXPECTED_STATUSES as readonly string[]).includes(expectedStatus) ||
      typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status) ||
      (reasonCode !== undefined && reasonCode !== null && typeof reasonCode !== 'string') ||
      typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 200) {
    return NextResponse.json({ error: 'Provide a valid application, expected status, new status and idempotency key.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data, error } = await db.rpc('transition_employer_application', {
    p_company_id: params.id,
    p_application_id: applicationId,
    p_actor_id: employer.user.id,
    p_expected_status: expectedStatus,
    p_new_status: status,
    p_reason_code: typeof reasonCode === 'string' && reasonCode.length ? reasonCode : null,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const message = error.message || '';
    if (message.includes('application_not_found')) return NextResponse.json({ error: 'Application not found.' }, { status: 404 });
    if (message.includes('employer_forbidden') || message.includes('service_role_required')) return NextResponse.json({ error: 'You cannot update this application.' }, { status: 403 });
    if (message.includes('status_conflict') || message.includes('idempotency_conflict') ||
        message.includes('candidate_state_conflict') || message.includes('application_integrity_conflict')) {
      return NextResponse.json({ error: 'The application changed or is inconsistent. Refresh before trying again.' }, { status: 409 });
    }
    if (message.includes('invalid_transition')) return NextResponse.json({ error: 'That status transition is not permitted.' }, { status: 409 });
    if (message.includes('reason_required')) return NextResponse.json({ error: 'Select a reason for this decision.' }, { status: 400 });
    if (message.includes('invalid_reason_code') || message.includes('invalid_transition_request')) return NextResponse.json({ error: 'Invalid decision details.' }, { status: 400 });
    console.error('[employer/applications] transition RPC failed', { companyId: params.id, applicationId, code: error.code, message });
    return NextResponse.json({ error: 'Could not update applicant status.' }, { status: 500 });
  }

  const result = data as { success?: boolean; replayed?: boolean; status?: string; candidateStatus?: string } | null;
  if (!result?.success) return NextResponse.json({ error: 'Could not confirm the status update.' }, { status: 500 });
  return NextResponse.json(result);
}
