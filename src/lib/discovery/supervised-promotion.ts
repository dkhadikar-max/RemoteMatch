import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { DiscoveredCompany } from '@/types/discovery';

export interface PromotionResult {
  promoted: boolean;
  employerId?: string;
  sourceId?: string;
  atsProvider?: string | null;
  error?: string;
}

/**
 * Promotes a verified discovered company into `allowlist_employers`
 * and creates the linked `supply_sources` row if it uses a C3 ATS.
 *
 * Designed to execute under supervised review (e.g. CLI or admin script).
 */
export async function promoteCompanyToAllowlist(
  company: DiscoveredCompany,
  reviewedBy = 'supervised_c6_promotion'
): Promise<PromotionResult> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { promoted: false, error: 'supabase_admin_not_configured' };
  }

  const rootDomain = company.resolvedRootDomain || company.rawDomain;
  const careerUrl = company.discoveredCareerUrl || `https://${rootDomain}/careers`;
  const atsPlatform = company.discoveredAtsPlatform;
  const atsBoard = company.discoveredAtsBoard;

  try {
    let linkedSourceId: string | null = null;

    // 1. If company uses Greenhouse, Lever, or Ashby, create/link supply_sources row
    if (atsPlatform === 'greenhouse' || atsPlatform === 'lever' || atsPlatform === 'ashby') {
      if (!atsBoard) {
        return { promoted: false, error: 'missing_ats_board_token' };
      }

      // Check if supply_source already exists for (platform_slug, board)
      const { data: existingSource } = await admin
        .from('supply_sources')
        .select('id')
        .eq('platform_slug', atsPlatform)
        .eq('board', atsBoard)
        .maybeSingle();

      if (existingSource) {
        linkedSourceId = existingSource.id;
      } else {
        const { data: newSource, error: sourceErr } = await admin
          .from('supply_sources')
          .insert({
            platform_slug: atsPlatform,
            board: atsBoard,
            employer_name: company.canonicalName,
            endpoint_template: careerUrl,
            acquisition_method: 'http_json',
            extraction_method: 'native_adapter',
            permission_basis: 'public_ats_read',
            review_status: 'approved',
            reviewed_at: new Date().toISOString(),
            reviewed_by: reviewedBy,
            review_reason: 'C6 automated discovery verified token',
            status: 'active',
          })
          .select('id')
          .single();

        if (sourceErr || !newSource) {
          return { promoted: false, error: `source_insert_failed: ${sourceErr?.message}` };
        }
        linkedSourceId = newSource.id;
      }
    }

    // 2. Insert into allowlist_employers
    const atsProviderCol = (atsPlatform === 'greenhouse' || atsPlatform === 'lever' || atsPlatform === 'ashby')
      ? atsPlatform
      : null;

    // Check if employer already exists for (ats_provider, official_domain)
    let query = admin
      .from('allowlist_employers')
      .select('id')
      .eq('official_domain', rootDomain);
    
    if (atsProviderCol) {
      query = query.eq('ats_provider', atsProviderCol);
    } else {
      query = query.is('ats_provider', null);
    }

    const { data: existingEmployer } = await query.maybeSingle();

    let employerId: string;

    if (existingEmployer) {
      employerId = existingEmployer.id;
      // Update review status to approved if it was pending
      await admin
        .from('allowlist_employers')
        .update({
          review_status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: reviewedBy,
          linked_source_id: linkedSourceId,
        })
        .eq('id', employerId);
    } else {
      const { data: newEmp, error: empErr } = await admin
        .from('allowlist_employers')
        .insert({
          canonical_name: company.canonicalName,
          official_domain: rootDomain,
          career_url: careerUrl,
          ats_provider: atsProviderCol,
          source_url: careerUrl,
          remote_evidence: company.remoteEvidenceSnippet || 'Verified remote-eligible via C6 automated discovery',
          review_status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: reviewedBy,
          review_reason: 'C6 automated discovery promotion',
          linked_source_id: linkedSourceId,
        })
        .select('id')
        .single();

      if (empErr || !newEmp) {
        return { promoted: false, error: `employer_insert_failed: ${empErr?.message}` };
      }
      employerId = newEmp.id;
    }

    // 3. Mark discovered company row as promoted_to_allowlist if id provided
    if (company.id) {
      await admin
        .from('supply_discovered_companies')
        .update({
          pipeline_stage: 'promoted_to_allowlist',
          last_probed_at: new Date().toISOString(),
        })
        .eq('id', company.id);
    }

    return {
      promoted: true,
      employerId,
      sourceId: linkedSourceId || undefined,
      atsProvider: atsProviderCol,
    };
  } catch (err) {
    return { promoted: false, error: (err as Error).message };
  }
}

export interface RejectionResult {
  rejected: boolean;
  error?: string;
}

/**
 * Rejects a discovered company — sets `pipeline_stage='rejected'` with a
 * human-supplied reason. Added for the admin console (admin.remotematch.
 * online) alongside promoteCompanyToAllowlist(), NOT a modification of it —
 * that function is untouched above. Deliberately as small/symmetrical as
 * the promotion path: no allowlist_employers/supply_sources writes, no
 * ATS-board validation, since rejection has no downstream registry effect
 * to get wrong.
 */
export async function rejectDiscoveredCompany(
  companyId: string,
  reason: string
): Promise<RejectionResult> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { rejected: false, error: 'supabase_admin_not_configured' };
  }

  const { error } = await admin
    .from('supply_discovered_companies')
    .update({
      pipeline_stage: 'rejected',
      rejection_reason: reason,
      last_probed_at: new Date().toISOString(),
    })
    .eq('id', companyId);

  if (error) {
    return { rejected: false, error: error.message };
  }
  return { rejected: true };
}
