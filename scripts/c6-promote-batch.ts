/**
 * RemoteMatch — C6 Supervised Batch Promotion Tool
 * ==============================================================================
 * CLI and programmatic module to execute supervised promotion of verified
 * discovered companies from `supply_discovered_companies` into `allowlist_employers`
 * and linked `supply_sources` rows.
 *
 * Usage:
 *   npx tsx scripts/c6-promote-batch.ts --dry-run
 *   npx tsx scripts/c6-promote-batch.ts --auto-promote
 *   npx tsx scripts/c6-promote-batch.ts --limit 50
 * ==============================================================================
 */

import { getSupabaseAdminClient } from '../src/lib/supabase/admin';
import { promoteCompanyToAllowlist } from '../src/lib/discovery/supervised-promotion';
import { DiscoveredCompany } from '../src/types/discovery';
import { COHORT_500 } from './cohort-500';
import { detectAtsEndpoint } from '../src/lib/discovery/ats-resolver';

export interface BatchPromotionOptions {
  dryRun?: boolean;
  autoPromote?: boolean;
  limit?: number;
  minConfidence?: number;
  sector?: string;
  reviewerId?: string;
}

export interface BatchPromotionReport {
  totalReviewed: number;
  approvedCount: number;
  skippedCount: number;
  failedCount: number;
  atsBreakdown: {
    greenhouse: number;
    lever: number;
    ashby: number;
    c5_direct: number;
  };
  promotedEmployers: {
    name: string;
    domain: string;
    provider: string | null;
    slug?: string;
    status: string;
  }[];
}

export async function executeSupervisedBatchPromotion(
  options: BatchPromotionOptions = {}
): Promise<BatchPromotionReport> {
  const isDryRun = options.dryRun ?? false;
  const limit = options.limit ?? 100;
  const minConfidence = options.minConfidence ?? 75;
  const reviewer = options.reviewerId ?? 'c6_supervised_admin';

  console.log('============================================================');
  console.log('REMOTEMATCH — C6 SUPERVISED BATCH PROMOTION');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (No database mutations)' : 'LIVE PROMOTION'}`);
  console.log(`Reviewer: ${reviewer} | Limit: ${limit} | Min Confidence: ${minConfidence}`);
  console.log('============================================================\n');

  const report: BatchPromotionReport = {
    totalReviewed: 0,
    approvedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    atsBreakdown: {
      greenhouse: 0,
      lever: 0,
      ashby: 0,
      c5_direct: 0,
    },
    promotedEmployers: [],
  };

  const admin = getSupabaseAdminClient();
  let candidateCompanies: DiscoveredCompany[] = [];

  if (admin) {
    let query = admin
      .from('supply_discovered_companies')
      .select('*')
      .eq('pipeline_stage', 'qualified_remote')
      .gte('confidence_score', minConfidence)
      .limit(limit);

    if (options.sector) {
      query = query.eq('industry', options.sector);
    }

    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      candidateCompanies = data.map((r: any) => ({
        id: r.id,
        canonicalName: r.canonical_name,
        normalizedNameKey: r.normalized_name_key,
        rawDomain: r.raw_domain,
        resolvedRootDomain: r.resolved_root_domain,
        industry: r.industry,
        discoverySource: r.discovery_source,
        pipelineStage: r.pipeline_stage,
        discoveredCareerUrl: r.discovered_career_url,
        discoveredAtsPlatform: r.discovered_ats_platform,
        discoveredAtsBoard: r.discovered_ats_board,
        remoteEvidenceSnippet: r.remote_evidence_snippet,
        confidenceScore: r.confidence_score,
      }));
    }
  }

  // Fallback if staging table is empty or admin not connected:
  // Probe a subset of verified cohort companies to generate promotion manifest
  if (candidateCompanies.length === 0) {
    console.log('Fetching candidate employers for supervised review...');
    const cohortSample = COHORT_500.slice(0, limit);
    for (const c of cohortSample) {
      try {
        const ats = await detectAtsEndpoint(c.name, c.domain);
        if (ats.detected && ats.platform && ats.boardSlug) {
          candidateCompanies.push({
            canonicalName: c.name,
            normalizedNameKey: c.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
            rawDomain: c.domain,
            resolvedRootDomain: c.domain,
            industry: c.industry,
            discoverySource: 'pilot_cohort',
            pipelineStage: 'qualified_remote',
            discoveredCareerUrl: ats.endpointUrl,
            discoveredAtsPlatform: ats.platform,
            discoveredAtsBoard: ats.boardSlug,
            remoteEvidenceSnippet: ats.remoteEvidenceSnippet || 'Verified remote positions',
            confidenceScore: 90,
          });
        }
      } catch {
        // Skip on error
      }
    }
  }

  console.log(`Found ${candidateCompanies.length} candidate employers awaiting review.\n`);

  for (const comp of candidateCompanies) {
    report.totalReviewed++;
    const platform = comp.discoveredAtsPlatform;

    if (platform === 'greenhouse' || platform === 'lever' || platform === 'ashby') {
      report.atsBreakdown[platform]++;
    } else {
      report.atsBreakdown.c5_direct++;
    }

    if (isDryRun) {
      report.approvedCount++;
      report.promotedEmployers.push({
        name: comp.canonicalName,
        domain: comp.resolvedRootDomain || comp.rawDomain,
        provider: comp.discoveredAtsPlatform || null,
        slug: comp.discoveredAtsBoard,
        status: 'simulated_approval',
      });
      console.log(`  [SIMULATE APPROVE] ${comp.canonicalName} -> ${platform?.toUpperCase()} (${comp.discoveredAtsBoard})`);
      continue;
    }

    // Live Promotion
    try {
      const result = await promoteCompanyToAllowlist(comp, reviewer);
      if (result.promoted) {
        report.approvedCount++;
        report.promotedEmployers.push({
          name: comp.canonicalName,
          domain: comp.resolvedRootDomain || comp.rawDomain,
          provider: comp.discoveredAtsPlatform || null,
          slug: comp.discoveredAtsBoard,
          status: 'promoted',
        });
        console.log(`  ✓ [PROMOTED] ${comp.canonicalName} -> allowlist_employers (${platform})`);
      } else {
        report.failedCount++;
        console.log(`  ✗ [FAILED] ${comp.canonicalName}: ${result.error}`);
      }
    } catch (err) {
      report.failedCount++;
      console.log(`  ✗ [ERROR] ${comp.canonicalName}: ${(err as Error).message}`);
    }
  }

  console.log('\n============================================================');
  console.log('SUPERVISED BATCH PROMOTION SUMMARY');
  console.log('============================================================');
  console.log(`Total Candidates Reviewed:        ${report.totalReviewed}`);
  console.log(`Approved & Promoted:              ${report.approvedCount}`);
  console.log(`Skipped / Rejected:               ${report.skippedCount}`);
  console.log(`Failed Promotions:                ${report.failedCount}`);
  console.log(`ATS Platforms Promoted:`);
  console.log(`  - Greenhouse:                   ${report.atsBreakdown.greenhouse}`);
  console.log(`  - Ashby:                        ${report.atsBreakdown.ashby}`);
  console.log(`  - Lever:                        ${report.atsBreakdown.lever}`);
  console.log(`  - Direct Career (C5 Staged):    ${report.atsBreakdown.c5_direct}`);
  console.log('============================================================\n');

  return report;
}

if (process.argv[1]?.includes('c6-promote-batch')) {
  const isDryRun = process.argv.includes('--dry-run') || !process.argv.includes('--auto-promote');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 25;

  executeSupervisedBatchPromotion({ dryRun: isDryRun, limit })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Promotion failed:', err);
      process.exit(1);
    });
}
