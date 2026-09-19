import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

const PAGE_SIZE = 30;

/**
 * GET /api/admin/users — the directory. Only what the request explicitly
 * asked for: email, signup date, plan tier, activity counts. Deliberately
 * never selects raw_resume_text, stripe_customer_id/stripe_subscription_id,
 * linkedin_url/github_url, or any other field not needed for this list —
 * "do not expose unnecessary sensitive information" applied at the query
 * level, not just the UI.
 */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const q = searchParams.get('q');
  const planTier = searchParams.get('planTier');

  let query = admin
    .from('profiles')
    .select('id, email, full_name, plan_tier, created_at, onboarding_completed_at', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (q) query = query.ilike('email', `%${q}%`);
  if (planTier) query = query.eq('plan_tier', planTier);

  const from = (page - 1) * PAGE_SIZE;
  const { data: profiles, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (profiles ?? []).map((p) => p.id);

  // Complete per-user counts: paginated (a page of users can own more than
  // the 1,000 rows PostgREST returns from a single un-ranged select), and a
  // failed lookup is an explicit 500 — never a silent 0 swipes / 0 applications.
  const readOwnedRows = (table: 'swipes' | 'applications') =>
    ids.length
      ? fetchAllRows<{ id: string; profile_id: string }>(
          (afterId, pageSize) => {
            let q = admin
              .from(table)
              .select('id, profile_id')
              .in('profile_id', ids)
              .order('id', { ascending: true })
              .limit(pageSize);
            if (afterId) q = q.gt('id', afterId);
            return q;
          },
          { label: table }
        )
      : Promise.resolve([] as { id: string; profile_id: string }[]);

  let swipeRows: { id: string; profile_id: string }[];
  let appRows: { id: string; profile_id: string }[];
  try {
    [swipeRows, appRows] = await Promise.all([readOwnedRows('swipes'), readOwnedRows('applications')]);
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const countByProfile = (rows: { profile_id: string }[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.profile_id] = (m[r.profile_id] ?? 0) + 1;
    return m;
  };
  const swipeMap = countByProfile(swipeRows);
  const appMap = countByProfile(appRows);

  const users = (profiles ?? []).map((p) => ({
    ...p,
    swipeCount: swipeMap[p.id] ?? 0,
    applicationCount: appMap[p.id] ?? 0,
  }));

  return NextResponse.json({ users, total: count ?? 0, page, pageSize: PAGE_SIZE });
}
