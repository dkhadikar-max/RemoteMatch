import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const PAGE_SIZE = 30;

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
  const reviewStatus = searchParams.get('reviewStatus');
  const q = searchParams.get('q');

  let query = admin
    .from('allowlist_employers')
    .select('id, canonical_name, official_domain, career_url, ats_provider, review_status, reviewed_at, reviewed_by, linked_source_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (reviewStatus) query = query.eq('review_status', reviewStatus);
  if (q) query = query.ilike('canonical_name', `%${q}%`);

  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ employers: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
}
