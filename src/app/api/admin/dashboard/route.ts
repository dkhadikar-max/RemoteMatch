import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getFreshnessWindowBounds } from '@/lib/ingestion/freshness-gate';

/**
 * Every number here is a real, live COUNT()/aggregation against the actual
 * production tables — no hardcoded demo figures anywhere, per the explicit
 * requirement. Parallelized with Promise.all since every query is
 * independent and this route is read-only throughout.
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
  if (!admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  }

  const { from, to } = getFreshnessWindowBounds();

  const [
    totalOpportunities,
    activeOpportunities,
    freshOpportunities,
    activeEmployers,
    activeSources,
    opportunitiesBySourceRaw,
    opportunitiesByRemoteTypeRaw,
    discoveryByStageRaw,
    failedSourcesCount,
  ] = await Promise.all([
    admin.from('opportunities').select('id', { count: 'exact', head: true }),
    admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('status', 'active').gte('posted_at', from).lte('posted_at', to),
    admin.from('allowlist_employers').select('id', { count: 'exact', head: true }).eq('review_status', 'approved'),
    admin.from('supply_sources').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    admin.from('opportunities').select('source').eq('status', 'active'),
    admin.from('opportunities').select('remote_type').eq('status', 'active'),
    admin.from('supply_discovered_companies').select('pipeline_stage'),
    admin.from('supply_sources').select('id', { count: 'exact', head: true }).gt('consecutive_fetch_failures', 0),
  ]);

  const countBy = (rows: { [k: string]: string | null }[] | null, key: string) => {
    const counts: Record<string, number> = {};
    for (const row of rows ?? []) {
      const value = row[key] ?? 'unknown';
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };

  const jobsBySource = countBy(opportunitiesBySourceRaw.data as any, 'source');
  const jobsByRemoteScope = countBy(opportunitiesByRemoteTypeRaw.data as any, 'remote_type');
  const discoveryByStage = countBy(discoveryByStageRaw.data as any, 'pipeline_stage');

  return NextResponse.json({
    opportunities: {
      total: totalOpportunities.count ?? 0,
      active: activeOpportunities.count ?? 0,
      fresh48h: freshOpportunities.count ?? 0,
    },
    supply: {
      activeEmployers: activeEmployers.count ?? 0,
      activeSources: activeSources.count ?? 0,
      failedSources: failedSourcesCount.count ?? 0,
    },
    jobsBySource,
    jobsByRemoteScope,
    discovery: {
      byStage: discoveryByStage,
      candidatesTotal: (discoveryByStageRaw.data ?? []).length,
      awaitingReview: discoveryByStage['career_found'] ?? 0,
      qualifiedRemote: discoveryByStage['qualified_remote'] ?? 0,
      promoted: discoveryByStage['promoted_to_allowlist'] ?? 0,
      rejected: discoveryByStage['rejected'] ?? 0,
    },
  });
}
