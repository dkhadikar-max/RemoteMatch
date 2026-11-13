import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

const VALID_STATUSES = [
  'interested',
  'applied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
  'offer_declined',
] as const;

function isValidBody(
  body: unknown
): body is { opportunityId: string; expectedStatus: string; status: string; notes?: string } {
  if (!body || typeof body !== 'object') return false;
  const { opportunityId, expectedStatus, status, notes } = body as Record<string, unknown>;
  return (
    typeof opportunityId === 'string' &&
    opportunityId.trim().length > 0 &&
    opportunityId.length <= 200 &&
    typeof expectedStatus === 'string' &&
    (VALID_STATUSES as readonly string[]).includes(expectedStatus) &&
    typeof status === 'string' &&
    (VALID_STATUSES as readonly string[]).includes(status) &&
    (notes === undefined || typeof notes === 'string')
  );
}

export async function PATCH(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid status transition request' }, { status: 400 });
  }

  const { opportunityId, expectedStatus, status, notes } = body;
  const { data, error } = await auth.supabase.rpc('transition_application_status', {
    p_opportunity_id: opportunityId,
    p_expected_status: expectedStatus,
    p_new_status: status,
    p_notes: notes ?? null,
  });

  if (error) {
    const message = error.message || '';
    if (message.includes('application_not_found')) return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    if (message.includes('status_conflict')) {
      return NextResponse.json({ error: 'status_conflict', message: 'This application has changed since you last viewed it. Refresh and try again.' }, { status: 409 });
    }
    if (message.includes('managed_by_employer')) {
      return NextResponse.json({ error: 'managed_by_employer', message: 'The employer controls this stage of the application.' }, { status: 409 });
    }
    if (message.includes('application_integrity_conflict')) {
      return NextResponse.json({ error: 'application_integrity_conflict', message: 'This application needs support review.' }, { status: 409 });
    }
    if (message.includes('invalid_transition') || message.includes('managed_by_employer_or_invalid_transition')) {
      return NextResponse.json({ error: 'invalid_transition', message: 'That application status change is not permitted.' }, { status: 409 });
    }
    if (message.includes('invalid_status')) return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    console.error('[applications/status] transition RPC failed', { opportunityId, code: error.code, message });
    return NextResponse.json({ error: 'Could not update application status' }, { status: 500 });
  }

  return NextResponse.json(data);
}
