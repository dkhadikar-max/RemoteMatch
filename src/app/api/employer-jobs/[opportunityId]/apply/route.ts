import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Sign in to apply for this job.' }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { sourceId, coverNote } = body as Record<string, unknown>;
  if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sourceId) ||
      (coverNote !== undefined && (typeof coverNote !== 'string' || coverNote.length > 10000))) {
    return NextResponse.json({ error: 'Provide a valid job and cover note.' }, { status: 400 });
  }

  // One SECURITY DEFINER transaction creates/links the candidate and employer
  // application rows and writes both audit facts. Never write either row here.
  const { data, error } = await auth.supabase.rpc('apply_to_employer_job', {
    p_source_id: sourceId,
    p_cover_note: typeof coverNote === 'string' ? coverNote.trim() : null,
  });

  if (error) {
    const message = error.message || '';
    if (message.includes('unauthenticated')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (message.includes('job_not_accepting_applications')) return NextResponse.json({ error: 'This job is no longer accepting applications.' }, { status: 410 });
    if (message.includes('canonical_identity_missing')) return NextResponse.json({ error: 'This job cannot accept applications yet.' }, { status: 409 });
    if (message.includes('application_state_conflict') || message.includes('application_integrity_conflict')) {
      return NextResponse.json({ error: 'application_conflict', message: 'An application already exists in a conflicting state. Refresh your tracker or contact support.' }, { status: 409 });
    }
    if (message.includes('profile_not_found')) return NextResponse.json({ error: 'Complete your profile before applying.' }, { status: 409 });
    if (message.includes('invalid_application_request')) return NextResponse.json({ error: 'Provide a valid cover note.' }, { status: 400 });
    console.error('[employer-job-apply] atomic apply failed', { code: error.code, message });
    return NextResponse.json({ error: 'Could not submit your application. Please try again.' }, { status: 500 });
  }

  const result = data as { success?: boolean; replayed?: boolean } | null;
  if (!result?.success) return NextResponse.json({ error: 'Could not submit your application.' }, { status: 500 });
  return NextResponse.json(data, { status: result.replayed ? 200 : 201 });
}
