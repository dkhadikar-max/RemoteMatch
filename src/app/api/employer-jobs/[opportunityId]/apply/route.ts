import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  let auth;
  try { auth = await getAuthenticatedUser(req); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Sign in to apply for this job.' }, { status: 401 }); }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { sourceId, coverNote } = body as Record<string, unknown>;
  if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sourceId) ||
      (coverNote !== undefined && (typeof coverNote !== 'string' || coverNote.length > 10000))) {
    return NextResponse.json({ error: 'Provide a valid job and cover note.' }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Applications are temporarily unavailable.' }, { status: 503 });

  const { data: opportunity, error: opportunityError } = await db.from('opportunities')
    .select('id,source,status').eq('source', 'employerdirect').eq('source_id', sourceId).maybeSingle();
  if (opportunityError) return NextResponse.json({ error: 'Could not verify this job.' }, { status: 500 });
  if (!opportunity || opportunity.status !== 'active') {
    return NextResponse.json({ error: 'This job is not accepting applications through RemoteMatch.' }, { status: 404 });
  }

  const { data: submission, error: submissionError } = await db.from('employer_job_submissions')
    .select('id').eq('published_opportunity_id', opportunity.id).eq('status', 'published').maybeSingle();
  if (submissionError) return NextResponse.json({ error: 'Could not verify this job.' }, { status: 500 });
  if (!submission) return NextResponse.json({ error: 'This job is no longer accepting applications.' }, { status: 410 });

  const { data, error } = await db.from('employer_job_applications').insert({
    submission_id: submission.id,
    opportunity_id: opportunity.id,
    candidate_profile_id: auth.user.id,
    cover_note: typeof coverNote === 'string' ? coverNote.trim() : '',
  }).select('id,status,submitted_at').single();

  if (error?.code === '23505') return NextResponse.json({ error: 'You have already applied for this job.' }, { status: 409 });
  if (error) return NextResponse.json({ error: 'Could not submit your application. Please try again.' }, { status: 500 });
  return NextResponse.json({ application: data }, { status: 201 });
}
