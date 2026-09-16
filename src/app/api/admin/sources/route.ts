import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const PAGE_SIZE = 30;
const STALE_HOURS = 72; // a source untouched this long, while "active", reads as stale — a display heuristic only, not a DB flag

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
  const status = searchParams.get('status');
  const platform = searchParams.get('platform');

  let query = admin
    .from('supply_sources')
    .select(
      'id, platform_slug, board, employer_name, acquisition_method, status, ' +
        'consecutive_fetch_failures, last_fetch_attempt_at, last_successful_fetch_at, ' +
        'lifetime_jobs_ingested, created_at',
      { count: 'exact' }
    )
    .order('last_fetch_attempt_at', { ascending: false, nullsFirst: false });

  if (status) query = query.eq('status', status);
  if (platform) query = query.eq('platform_slug', platform);

  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  interface SourceRow {
    id: string;
    platform_slug: string;
    board: string;
    employer_name: string | null;
    acquisition_method: string;
    status: string;
    consecutive_fetch_failures: number;
    last_fetch_attempt_at: string | null;
    last_successful_fetch_at: string | null;
    lifetime_jobs_ingested: number;
    created_at: string;
  }

  const now = Date.now();
  const sources = ((data ?? []) as unknown as SourceRow[]).map((s) => {
    const lastAttempt = s.last_fetch_attempt_at ? new Date(s.last_fetch_attempt_at).getTime() : null;
    const staleHours = lastAttempt ? (now - lastAttempt) / (3600 * 1000) : null;
    let health: 'healthy' | 'failing' | 'stale' | 'never_run' = 'never_run';
    if (s.consecutive_fetch_failures > 0) health = 'failing';
    else if (staleHours !== null && staleHours > STALE_HOURS && s.status === 'active') health = 'stale';
    else if (lastAttempt !== null) health = 'healthy';
    return { ...s, health };
  });

  return NextResponse.json({ sources, total: count ?? 0, page, pageSize: PAGE_SIZE });
}
