import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

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
  const [swipeCounts, appCounts] = await Promise.all([
    ids.length ? admin.from('swipes').select('profile_id').in('profile_id', ids) : Promise.resolve({ data: [] as { profile_id: string }[] }),
    ids.length ? admin.from('applications').select('profile_id').in('profile_id', ids) : Promise.resolve({ data: [] as { profile_id: string }[] }),
  ]);

  const countByProfile = (rows: { profile_id: string }[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.profile_id] = (m[r.profile_id] ?? 0) + 1;
    return m;
  };
  const swipeMap = countByProfile(swipeCounts.data ?? []);
  const appMap = countByProfile(appCounts.data ?? []);

  const users = (profiles ?? []).map((p) => ({
    ...p,
    swipeCount: swipeMap[p.id] ?? 0,
    applicationCount: appMap[p.id] ?? 0,
  }));

  return NextResponse.json({ users, total: count ?? 0, page, pageSize: PAGE_SIZE });
}
