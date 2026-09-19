import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { promoteCompanyToAllowlist } from '@/lib/discovery/supervised-promotion';
import { recordAdminAction } from '@/lib/admin/audit-log';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';
import type { DiscoveredCompany } from '@/types/discovery';

/**
 * POST /api/admin/discovery/[id]/promote — the ONE path this console uses
 * to move a C6 candidate into the live supply registry. Calls
 * promoteCompanyToAllowlist() completely unmodified (src/lib/discovery/
 * supervised-promotion.ts) — this route IS the "supervised" boundary the
 * function's own doc comment describes: it can only ever be reached by an
 * authenticated, active admin clicking a button, never a timer or script.
 * `reviewedBy` is always the real admin's email — never that function's
 * own hardcoded default.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let admin;
  try {
    admin = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  // 404 only when the lookup succeeded and matched nothing. A failed lookup
  // (e.g. the staging table does not exist because migration 026 is not
  // applied) is a 500 that says so — it previously read "not found".
  let row;
  try {
    row = must(
      await db.from('supply_discovered_companies').select('*').eq('id', params.id).maybeSingle(),
      'supply_discovered_companies'
    ).data;
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Discovered company not found.' }, { status: 404 });
  }

  const company: DiscoveredCompany = {
    id: row.id,
    canonicalName: row.canonical_name,
    normalizedNameKey: row.normalized_name_key,
    rawDomain: row.raw_domain,
    resolvedRootDomain: row.resolved_root_domain ?? undefined,
    domainTld: row.domain_tld ?? undefined,
    countryCode: row.country_code ?? undefined,
    industry: row.industry ?? undefined,
    estimatedSize: row.estimated_size ?? undefined,
    discoverySource: row.discovery_source,
    discoveryMetadata: row.discovery_metadata ?? undefined,
    pipelineStage: row.pipeline_stage,
    rejectionReason: row.rejection_reason ?? undefined,
    discoveredCareerUrl: row.discovered_career_url ?? undefined,
    discoveredAtsPlatform: row.discovered_ats_platform ?? undefined,
    discoveredAtsBoard: row.discovered_ats_board ?? undefined,
    hasJsonLdJobs: row.has_json_ld_jobs ?? undefined,
    robotsPermission: row.robots_permission ?? undefined,
    remoteEvidenceSnippet: row.remote_evidence_snippet ?? undefined,
    confidenceScore: row.confidence_score ?? undefined,
    firstSeenAt: row.first_seen_at ?? undefined,
    lastProbedAt: row.last_probed_at ?? undefined,
    createdAt: row.created_at ?? undefined,
  };

  const result = await promoteCompanyToAllowlist(company, admin.adminEmail);

  const auditResult = await recordAdminAction({
    adminId: admin.user.id,
    adminEmail: admin.adminEmail,
    action: 'c6_promote',
    targetType: 'discovered_company',
    targetId: params.id,
    beforeState: { pipeline_stage: row.pipeline_stage },
    afterState: result.promoted
      ? { pipeline_stage: 'promoted_to_allowlist', employerId: result.employerId, sourceId: result.sourceId }
      : { error: result.error },
    reason: result.promoted ? null : `promotion failed: ${result.error}`,
  });

  if (!result.promoted) {
    return NextResponse.json({ error: result.error ?? 'Promotion failed.' }, { status: 422 });
  }

  return NextResponse.json({
    promoted: true,
    employerId: result.employerId,
    sourceId: result.sourceId,
    auditLogged: auditResult.ok,
  });
}
