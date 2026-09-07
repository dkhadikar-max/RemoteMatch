import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

function isValidBody(body: unknown): body is { opportunityId: string; notes: string } {
  if (!body || typeof body !== 'object') return false;
  const { opportunityId, notes } = body as Record<string, unknown>;
  return (
    typeof opportunityId === 'string' &&
    opportunityId.trim().length > 0 &&
    opportunityId.length <= 200 &&
    typeof notes === 'string' &&
    notes.length <= 5000
  );
}

/**
 * Notes-only edit — deliberately separate from PATCH /api/applications/status.
 * A notes edit is not a lifecycle transition (see update_application_notes()
 * in supabase/migrations/006_outcome_lifecycle.sql for why a same-status
 * "transition" isn't the right model for this).
 */
export async function PATCH(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid notes update request' }, { status: 400 });
  }
  const { opportunityId, notes } = body;

  const { error } = await supabase.rpc('update_application_notes', {
    p_opportunity_id: opportunityId,
    p_notes: notes,
  });

  if (error) {
    if (error.message.includes('application_not_found')) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Could not update notes' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
