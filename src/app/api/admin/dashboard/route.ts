import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getFreshnessWindowBounds } from '@/lib/ingestion/freshness-gate';
import { fetchAllRows, mustCount } from '@/lib/supabase/query-helpers';
import { runSections, partialFailureResponse } from '@/lib/admin/sections';

interface ActiveRow {
  id: string;
  source: string | null;
  remote_type: string | null;
  posted_at: string | null;
}

interface DiscoveryRow {
  id: string;
  pipeline_stage: string;
}

/**
 * Every number here is a real, live read against the production tables — no
 * hardcoded demo figures.
 *
 * Accuracy rules this route enforces (each one fixes a defect the admin
 * console previously shipped with):
 *  - The active-catalog headline, the fresh-48h count, and BOTH breakdowns
 *    are all derived from ONE complete paginated snapshot of the active
 *    rows, so they sum to the headline by construction. (The previous
 *    version headline-counted with head queries but built the breakdowns
 *    from an un-ranged select that PostgREST silently capped at 1,000 rows.)
 *  - No query error is ever converted into a zero. A section that fails is
 *    reported in `failedSections`; the response is then an HTTP 500 carrying
 *    whatever did compute in `partial`, so the UI can mark only the failed
 *    panels and a script or monitor can never mistake it for healthy.
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
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();

  const { values, failed } = await runSections({
    totalOpportunities: async () =>
      mustCount(
        await admin.from('opportunities').select('id', { count: 'exact', head: true }),
        'opportunities.total'
      ),

    activeSnapshot: async () => {
      const rows = await fetchAllRows<ActiveRow>(
        (afterId, pageSize) => {
          let q = admin
            .from('opportunities')
            .select('id, source, remote_type, posted_at')
            .eq('status', 'active')
            .order('id', { ascending: true })
            .limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'opportunities.active' }
      );

      const jobsBySource: Record<string, number> = {};
      const jobsByRemoteScope: Record<string, number> = {};
      let fresh48h = 0;
      for (const row of rows) {
        const source = row.source ?? 'unknown';
        const scope = row.remote_type ?? 'unknown';
        jobsBySource[source] = (jobsBySource[source] ?? 0) + 1;
        jobsByRemoteScope[scope] = (jobsByRemoteScope[scope] ?? 0) + 1;
        if (row.posted_at) {
          const postedMs = new Date(row.posted_at).getTime();
          if (postedMs >= fromMs && postedMs <= toMs) fresh48h++;
        }
      }
      return { active: rows.length, fresh48h, jobsBySource, jobsByRemoteScope };
    },

    activeEmployers: async () =>
      mustCount(
        await admin.from('allowlist_employers').select('id', { count: 'exact', head: true }).eq('review_status', 'approved'),
        'allowlist_employers.approved'
      ),

    activeSources: async () =>
      mustCount(
        await admin.from('supply_sources').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        'supply_sources.active'
      ),

    failedSources: async () =>
      mustCount(
        await admin.from('supply_sources').select('id', { count: 'exact', head: true }).gt('consecutive_fetch_failures', 0),
        'supply_sources.failing'
      ),

    // A missing table (migration 026 not applied) surfaces HERE as a failed
    // section with the real database message — it must never read as
    // "0 candidates".
    discovery: async () => {
      const rows = await fetchAllRows<DiscoveryRow>(
        (afterId, pageSize) => {
          let q = admin
            .from('supply_discovered_companies')
            .select('id, pipeline_stage')
            .order('id', { ascending: true })
            .limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'supply_discovered_companies' }
      );
      const byStage: Record<string, number> = {};
      for (const row of rows) byStage[row.pipeline_stage] = (byStage[row.pipeline_stage] ?? 0) + 1;
      return {
        byStage,
        candidatesTotal: rows.length,
        // The Discovery page only offers Promote/Reject at `qualified_remote`,
        // so that — not `career_found`, which is a career page found WITHOUT
        // remote evidence — is what "awaiting review" means.
        awaitingReview: byStage['qualified_remote'] ?? 0,
        careerFoundNotQualified: byStage['career_found'] ?? 0,
        promoted: byStage['promoted_to_allowlist'] ?? 0,
        rejected: byStage['rejected'] ?? 0,
      };
    },
  });

  // Defensive: by construction these must agree; if they ever do not, that
  // is itself a failure to report, not a discrepancy to display.
  if (values.activeSnapshot) {
    const s = values.activeSnapshot;
    const sourceSum = Object.values(s.jobsBySource).reduce((a, b) => a + b, 0);
    const scopeSum = Object.values(s.jobsByRemoteScope).reduce((a, b) => a + b, 0);
    if (sourceSum !== s.active || scopeSum !== s.active) {
      failed.push({
        section: 'consistency',
        message: `breakdown totals (${sourceSum} by source, ${scopeSum} by remote scope) do not equal the active count (${s.active})`,
      });
    }
  }

  const partial: Record<string, unknown> = { generatedAt: new Date().toISOString() };

  const opportunities: Record<string, number> = {};
  if (values.totalOpportunities !== undefined) opportunities.total = values.totalOpportunities;
  if (values.activeSnapshot) {
    opportunities.active = values.activeSnapshot.active;
    opportunities.fresh48h = values.activeSnapshot.fresh48h;
    partial.jobsBySource = values.activeSnapshot.jobsBySource;
    partial.jobsByRemoteScope = values.activeSnapshot.jobsByRemoteScope;
  }
  if (Object.keys(opportunities).length > 0) partial.opportunities = opportunities;

  const supply: Record<string, number> = {};
  if (values.activeEmployers !== undefined) supply.activeEmployers = values.activeEmployers;
  if (values.activeSources !== undefined) supply.activeSources = values.activeSources;
  if (values.failedSources !== undefined) supply.failedSources = values.failedSources;
  if (Object.keys(supply).length > 0) partial.supply = supply;

  if (values.discovery) partial.discovery = values.discovery;

  if (failed.length > 0) return partialFailureResponse(failed, partial);
  return NextResponse.json(partial);
}
