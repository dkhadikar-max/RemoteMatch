import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

/** Same minimal-exposure discipline as the list route — no resume text,
 *  no Stripe ids, no LinkedIn/GitHub URLs. Adds application-status
 *  breakdown, since that's the one useful "activity" detail the list view
 *  doesn't have room for. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const [{ data: profile, error }, { data: applications }, { data: swipes }] = await Promise.all([
    admin.from('profiles').select('id, email, full_name, plan_tier, created_at, onboarding_completed_at, usage_date').eq('id', params.id).single(),
    admin.from('applications').select('status').eq('profile_id', params.id),
    admin.from('swipes').select('action').eq('profile_id', params.id),
  ]);

  if (error || !profile) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const applicationsByStatus: Record<string, number> = {};
  for (const a of applications ?? []) applicationsByStatus[a.status] = (applicationsByStatus[a.status] ?? 0) + 1;
  const swipesByAction: Record<string, number> = {};
  for (const s of swipes ?? []) swipesByAction[s.action] = (swipesByAction[s.action] ?? 0) + 1;

  return NextResponse.json({ user: profile, applicationsByStatus, swipesByAction });
}
