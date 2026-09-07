import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

const VALID_OUTCOMES = ['applied', 'did_not_apply', 'not_eligible', 'expired', 'changed_mind'] as const;

function isValidBody(body: unknown): body is { opportunityId: string; didApply: string; notes?: string } {
  if (!body || typeof body !== 'object') return false;
  const { opportunityId, didApply, notes } = body as Record<string, unknown>;
  return (
    typeof opportunityId === 'string' &&
    opportunityId.trim().length > 0 &&
    opportunityId.length <= 200 &&
    typeof didApply === 'string' &&
    (VALID_OUTCOMES as readonly string[]).includes(didApply) &&
    (notes === undefined || typeof notes === 'string')
  );
}

/**
 * Previously: no authentication at all, and its body called
 * localStore.recordFeedback() — a module-level singleton whose
 * syncToStorage() no-ops server-side (`typeof window === 'undefined'`), so
 * this route mutated shared in-memory state across whatever concurrent
 * requests happened to land on the same warm server instance, keyed only by
 * opportunityId (not by user), and persisted nothing. Now: authenticated,
 * ownership-scoped, durable — see record_application_feedback() in
 * supabase/migrations/006_outcome_lifecycle.sql.
 */
export async function POST(req: NextRequest) {
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
    return NextResponse.json({ error: 'Missing or invalid feedback fields' }, { status: 400 });
  }
  const { opportunityId, didApply, notes } = body;

  const { error } = await supabase.rpc('record_application_feedback', {
    p_opportunity_id: opportunityId,
    p_did_apply: didApply,
    p_notes: notes ?? null,
  });

  if (error) {
    if (error.message.includes('application_not_found')) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Could not record feedback' }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: 'Feedback and outcome event recorded successfully' });
}
