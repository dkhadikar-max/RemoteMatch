import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows, must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

/** Same minimal-exposure discipline as the list route — no resume text,
 *  no Stripe ids, no LinkedIn/GitHub URLs. Adds application-status
 *  breakdown, since that's the one useful "activity" detail the list view
 *  doesn't have room for.
 *
 *  "User not found" (404) now means the lookup succeeded and matched no row.
 *  A failed query is a 500 — previously every error, including a database
 *  outage, was reported as "User not found." */
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

  try {
    const profileRes = must(
      await admin
        .from('profiles')
        .select('id, email, full_name, plan_tier, created_at, onboarding_completed_at, usage_date')
        .eq('id', params.id)
        .maybeSingle(),
      'profiles'
    );
    if (!profileRes.data) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

    const [applications, swipes] = await Promise.all([
      fetchAllRows<{ id: string; status: string }>(
        (afterId, pageSize) => {
          let q = admin.from('applications').select('id, status').eq('profile_id', params.id).order('id', { ascending: true }).limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'applications' }
      ),
      fetchAllRows<{ id: string; action: string }>(
        (afterId, pageSize) => {
          let q = admin.from('swipes').select('id, action').eq('profile_id', params.id).order('id', { ascending: true }).limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'swipes' }
      ),
    ]);

    const applicationsByStatus: Record<string, number> = {};
    for (const a of applications) applicationsByStatus[a.status] = (applicationsByStatus[a.status] ?? 0) + 1;
    const swipesByAction: Record<string, number> = {};
    for (const s of swipes) swipesByAction[s.action] = (swipesByAction[s.action] ?? 0) + 1;

    return NextResponse.json({ user: profileRes.data, applicationsByStatus, swipesByAction });
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
