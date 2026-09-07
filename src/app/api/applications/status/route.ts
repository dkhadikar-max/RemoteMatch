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

/**
 * The only client-reachable path that can change an application's lifecycle
 * state. Everything else — transition-rule enforcement, compare-and-swap
 * against the caller's observed status, the atomic status+event write,
 * ownership scoping — happens inside transition_application_status() (see
 * supabase/migrations/007_application_transition_cas.sql). This route's job
 * is only to authenticate the caller and shape the RPC's response/errors
 * into HTTP.
 *
 * `expectedStatus` is required, not optional: the caller must state which
 * status it observed before deciding to make this request, so the RPC can
 * detect "the application moved since I last looked" instead of silently
 * proceeding from whatever the row happens to be at now (see 007's header
 * for the concurrency defect this closes).
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
    return NextResponse.json({ error: 'Invalid status transition request' }, { status: 400 });
  }
  const { opportunityId, expectedStatus, status, notes } = body;

  const { data, error } = await supabase.rpc('transition_application_status', {
    p_opportunity_id: opportunityId,
    p_expected_status: expectedStatus,
    p_new_status: status,
    p_notes: notes ?? null,
  });

  if (error) {
    if (error.message.includes('application_not_found')) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    }
    if (error.message.includes('status_conflict')) {
      return NextResponse.json(
        { error: 'status_conflict', message: 'This application has changed since you last viewed it. Refresh and try again.' },
        { status: 409 }
      );
    }
    if (error.message.includes('invalid_transition')) {
      return NextResponse.json(
        { error: 'invalid_transition', message: `Cannot move to "${status}" from the application's current state.` },
        { status: 409 }
      );
    }
    if (error.message.includes('invalid_status')) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not update application status' }, { status: 500 });
  }

  return NextResponse.json(data);
}
