import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedEmployer } from '@/lib/auth/get-authenticated-employer';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const STATUSES = ['submitted','reviewing','shortlisted','rejected','hired'] as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { await getAuthenticatedEmployer(req, id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data, error } = await db.from('employer_job_applications')
    .select('id,submission_id,opportunity_id,cover_note,status,submitted_at,updated_at,employer_job_submissions!inner(title),profiles!employer_job_applications_candidate_profile_id_fkey(id,email,full_name,headline,avatar_url,resume_file_url,linkedin_url)')
    .eq('employer_job_submissions.company_id', id)
    .order('submitted_at', { ascending: false });
  if (error) {
    console.error('[employer/applications] list failed', { companyId: id, error: error.message });
    return NextResponse.json({ error: 'Could not load applications.' }, { status: 500 });
  }
  return NextResponse.json({ applications: data ?? [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let employer;
  try { employer = await getAuthenticatedEmployer(req, id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  if (employer.role === 'member') return NextResponse.json({ error: 'Only company owners and admins can update applicant status.' }, { status: 403 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { applicationId, status } = body as Record<string, unknown>;
  if (typeof applicationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(applicationId) ||
      typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: 'Provide a valid application and status.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  const { data: owned, error: ownedError } = await db.from('employer_job_applications')
    .select('id,employer_job_submissions!inner(company_id)')
    .eq('id', applicationId).eq('employer_job_submissions.company_id', id).maybeSingle();
  if (ownedError) return NextResponse.json({ error: 'Could not verify application ownership.' }, { status: 500 });
  if (!owned) return NextResponse.json({ error: 'Application not found.' }, { status: 404 });

  const { error } = await db.from('employer_job_applications')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', applicationId);
  if (error) return NextResponse.json({ error: 'Could not update applicant status.' }, { status: 500 });
  return NextResponse.json({ success: true, status });
}
