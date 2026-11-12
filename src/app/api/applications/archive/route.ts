import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

export async function POST(req: NextRequest) {
  let auth;
  try { auth = await getAuthenticatedUser(req); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid archive request' }, { status: 400 });
  }
  const { opportunityId, archived } = body as Record<string, unknown>;
  if (typeof opportunityId !== 'string' || !opportunityId.trim() || opportunityId.length > 200 ||
      typeof archived !== 'boolean') {
    return NextResponse.json({ error: 'Provide an opportunity ID and archived boolean.' }, { status: 400 });
  }

  const { data, error } = await auth.supabase.rpc('set_application_archived', {
    p_opportunity_id: opportunityId,
    p_archived: archived,
  });
  if (error) {
    const message = error.message || '';
    if (message.includes('application_not_found')) return NextResponse.json({ error: 'Application not found.' }, { status: 404 });
    if (message.includes('not_direct_application')) return NextResponse.json({ error: 'Only direct employer applications support archive preferences.' }, { status: 409 });
    if (message.includes('application_integrity_conflict')) return NextResponse.json({ error: 'Application integrity conflict.' }, { status: 409 });
    if (message.includes('invalid_archive_request')) return NextResponse.json({ error: 'Invalid archive request.' }, { status: 400 });
    return NextResponse.json({ error: 'Could not update archive preference.' }, { status: 500 });
  }
  return NextResponse.json(data);
}
