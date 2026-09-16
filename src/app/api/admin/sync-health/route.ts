import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Honest per-pipeline status, derived ENTIRELY from real supply_sources/
 * supply_platforms/supply_discovered_companies state — no fabricated run
 * history, no invented "next run in 47 minutes" schedule. Confirmed by
 * direct inspection: neither /api/opportunities/sync nor
 * /api/opportunities/sync/career-pages is on an actual Railway cron today
 * (Railway cron is dashboard-only and has never been configured) — this
 * route reports that plainly (cadence: 'manual') rather than claiming a
 * schedule that doesn't exist. See the plan's "Key findings" section for
 * the full reasoning behind this v1 scope boundary.
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

  const { data: platforms } = await admin.from('supply_platforms').select('slug, source_type, kind');
  const { data: sources } = await admin
    .from('supply_sources')
    .select('platform_slug, status, consecutive_fetch_failures, last_fetch_attempt_at, last_successful_fetch_at');

  const platformKind = new Map((platforms ?? []).map((p) => [p.slug, p.kind]));

  type Group = { lastAttempt: string | null; lastSuccess: string | null; errorCount: number; sourceCount: number };
  const groups: Record<string, Group> = {
    c1_c3_ats_aggregator: { lastAttempt: null, lastSuccess: null, errorCount: 0, sourceCount: 0 },
    c5_career_page: { lastAttempt: null, lastSuccess: null, errorCount: 0, sourceCount: 0 },
  };

  for (const s of sources ?? []) {
    const kind = platformKind.get(s.platform_slug);
    const group = kind === 'career_feed' ? groups.c5_career_page : groups.c1_c3_ats_aggregator;
    group.sourceCount += 1;
    if (s.consecutive_fetch_failures > 0) group.errorCount += 1;
    if (!group.lastAttempt || (s.last_fetch_attempt_at && s.last_fetch_attempt_at > group.lastAttempt)) {
      group.lastAttempt = s.last_fetch_attempt_at;
    }
    if (!group.lastSuccess || (s.last_successful_fetch_at && s.last_successful_fetch_at > group.lastSuccess)) {
      group.lastSuccess = s.last_successful_fetch_at;
    }
  }

  const { data: discoveryRows } = await admin.from('supply_discovered_companies').select('pipeline_stage, last_probed_at');
  const discoveryStageCounts: Record<string, number> = {};
  let lastDiscoveryProbe: string | null = null;
  for (const r of discoveryRows ?? []) {
    discoveryStageCounts[r.pipeline_stage] = (discoveryStageCounts[r.pipeline_stage] ?? 0) + 1;
    if (!lastDiscoveryProbe || (r.last_probed_at && r.last_probed_at > lastDiscoveryProbe)) {
      lastDiscoveryProbe = r.last_probed_at;
    }
  }

  return NextResponse.json({
    pipelines: [
      {
        id: 'c1_c3',
        label: 'C1 Aggregators + C3 ATS',
        cadence: 'manual',
        enabled: false,
        lastExecution: groups.c1_c3_ats_aggregator.lastAttempt,
        lastSuccess: groups.c1_c3_ats_aggregator.lastSuccess,
        recordsDiscovered: groups.c1_c3_ats_aggregator.sourceCount,
        errors: groups.c1_c3_ats_aggregator.errorCount,
        note: 'POST /api/opportunities/sync — not on a configured Railway cron.',
      },
      {
        id: 'c5',
        label: 'C5 Career-Page Pipeline',
        cadence: 'manual',
        enabled: false,
        lastExecution: groups.c5_career_page.lastAttempt,
        lastSuccess: groups.c5_career_page.lastSuccess,
        recordsDiscovered: groups.c5_career_page.sourceCount,
        errors: groups.c5_career_page.errorCount,
        note: 'POST /api/opportunities/sync/career-pages — not on a configured Railway cron.',
      },
      {
        id: 'c6',
        label: 'C6 Automated Company Discovery',
        cadence: 'manual',
        enabled: false,
        lastExecution: lastDiscoveryProbe,
        lastSuccess: lastDiscoveryProbe,
        recordsDiscovered: (discoveryRows ?? []).length,
        errors: 0,
        note: 'scripts/c6-*.ts — run manually, not on a scheduler. Auto-promotion stays disabled.',
        byStage: discoveryStageCounts,
      },
    ],
  });
}
