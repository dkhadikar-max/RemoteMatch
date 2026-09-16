import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const PAGE_SIZE = 30;

/** GET /api/admin/opportunities — search/filter by title, company, source,
 *  remote eligibility, posted date, status, translation status. Read-only
 *  list view; full record + the one safe mutation live at [id]. */
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
  const company = searchParams.get('company');
  const source = searchParams.get('source');
  const remoteType = searchParams.get('remoteType');
  const status = searchParams.get('status');
  const translationStatus = searchParams.get('translationStatus');
  const postedAfter = searchParams.get('postedAfter');

  let query = admin
    .from('opportunities')
    .select(
      'id, title, company, source, source_id, remote_type, status, posted_at, ' +
        'official_url, translation_status, source_language, quality_score',
      { count: 'exact' }
    )
    .order('posted_at', { ascending: false });

  if (q) query = query.ilike('title', `%${q}%`);
  if (company) query = query.ilike('company', `%${company}%`);
  if (source) query = query.eq('source', source);
  if (remoteType) query = query.eq('remote_type', remoteType);
  if (status) query = query.eq('status', status);
  if (translationStatus) query = query.eq('translation_status', translationStatus);
  if (postedAfter) query = query.gte('posted_at', postedAfter);

  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ opportunities: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
}
