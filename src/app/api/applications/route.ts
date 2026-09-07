import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Server-authoritative replacement for the tracker's old
 * `localStore.getAllApplications()` (localStorage, per-browser, never
 * synced). Returns the caller's own applications with the fit-score
 * snapshot recorded at swipe time — no separate `matches` table lookup
 * needed; that data already lives in `swipes.decision_snapshot`.
 */
export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const { data: applications, error } = await supabase
    .from('applications')
    .select('id, opportunity_id, status, applied_at, notes, created_at, updated_at')
    .eq('profile_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Could not load applications' }, { status: 500 });
  }

  const opportunityIds = (applications ?? []).map((a) => a.opportunity_id);
  const { data: swipes } = opportunityIds.length
    ? await supabase
        .from('swipes')
        .select('opportunity_id, decision_snapshot')
        .eq('profile_id', user.id)
        .eq('action', 'interested')
        .in('opportunity_id', opportunityIds)
    : { data: [] };

  const snapshotByOpportunity = new Map(
    (swipes ?? []).map((s) => [s.opportunity_id, s.decision_snapshot as Record<string, unknown> | null])
  );

  return NextResponse.json({
    applications: (applications ?? []).map((a) => ({
      id: a.id,
      opportunityId: a.opportunity_id,
      status: a.status,
      appliedAt: a.applied_at,
      notes: a.notes,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      decisionSnapshot: snapshotByOpportunity.get(a.opportunity_id) ?? null,
    })),
  });
}
