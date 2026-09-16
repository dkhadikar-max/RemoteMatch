import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const PAGE_SIZE = 25;

/** GET /api/admin/discovery — the C6 human-review list, with the exact
 *  filters requested: pipeline_stage, ATS provider, confidence range,
 *  sector (industry). Read-only; promotion/rejection are separate routes. */
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
  const stage = searchParams.get('stage');
  const atsProvider = searchParams.get('atsProvider');
  const sector = searchParams.get('sector');
  const minConfidence = searchParams.get('minConfidence');

  let query = admin
    .from('supply_discovered_companies')
    .select(
      'id, canonical_name, raw_domain, resolved_root_domain, industry, discovery_source, ' +
        'pipeline_stage, rejection_reason, discovered_career_url, discovered_ats_platform, ' +
        'discovered_ats_board, has_json_ld_jobs, robots_permission, remote_evidence_snippet, ' +
        'confidence_score, first_seen_at, last_probed_at',
      { count: 'exact' }
    )
    .order('confidence_score', { ascending: false })
    .order('first_seen_at', { ascending: false });

  if (stage) query = query.eq('pipeline_stage', stage);
  if (atsProvider) query = query.eq('discovered_ats_platform', atsProvider);
  if (sector) query = query.ilike('industry', `%${sector}%`);
  if (minConfidence) query = query.gte('confidence_score', parseInt(minConfidence, 10) || 0);

  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ candidates: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
}
