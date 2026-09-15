/**
 * RemoteMatch — C6-7 Production Discovery Pipeline Orchestrator
 * ==============================================================================
 * Automates the recurring discovery and qualification of candidate employers:
 *
 * 1. Multi-source domain ingestion with SSRF & blocklist protection.
 * 2. Deterministic public ATS endpoint probing (Greenhouse, Lever, Ashby).
 * 3. Canonical career surface detection & robots.txt permission check.
 * 4. Automated qualification rules (token valid, active postings >= 1, remote evidence, score >= 75).
 * 5. Circuit breakers & error-rate monitoring (aborts if > 10% 429/rate-limited).
 * 6. Segregation of direct career pages for C5 ingestion.
 * 7. Decoupled staging queue write (supply_discovered_companies).
 * ==============================================================================
 */

import {
  DiscoveredCompany,
  PipelineStage,
  AtsProbeResult,
  CareerSurfaceResult,
} from '@/types/discovery';
import { resolveOfficialDomain, isDomainBlocklisted } from './domain-resolver';
import { detectAtsEndpoint } from './ats-resolver';
import { findCareerSurface } from './career-finder';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export interface ProductionPipelineConfig {
  concurrency?: number;
  probeTimeoutMs?: number;
  minConfidenceScore?: number;
  maxRateLimitErrorRatio?: number;
  reviewedBy?: string;
}

export interface BatchCandidateInput {
  name: string;
  domain: string;
  industry?: string;
  source?: string;
}

export interface PipelineExecutionMetrics {
  totalEvaluated: number;
  websitesVerified: number;
  blocklistedCount: number;
  atsDetectedCount: {
    greenhouse: number;
    lever: number;
    ashby: number;
    total: number;
  };
  directCareerPageCount: number;
  qualifiedRemoteCount: number;
  rejectedCount: number;
  circuitBreakerTriggered: boolean;
  rateLimitErrorCount: number;
  candidates: DiscoveredCompany[];
}

/**
 * Evaluates candidate discovery evidence against C6-7 automated qualification rules.
 */
export function evaluateQualification(
  candidate: BatchCandidateInput,
  domainResult: { valid: boolean; finalUrl?: string; rootDomain?: string; rejectionReason?: string },
  atsResult?: AtsProbeResult,
  careerResult?: CareerSurfaceResult
): {
  stage: PipelineStage;
  confidenceScore: number;
  rejectionReason?: string;
  remoteEvidence?: string;
} {
  if (!domainResult.valid) {
    return {
      stage: 'rejected',
      confidenceScore: 0,
      rejectionReason: domainResult.rejectionReason || 'domain_resolution_failed',
    };
  }

  // 1. Qualified ATS Candidate
  if (atsResult && atsResult.detected && atsResult.platform && atsResult.boardSlug) {
    const hasActivePostings = (atsResult.sampleJobsCount || 0) > 0;
    const hasRemoteJobs = (atsResult.remoteJobsCount || 0) > 0 || Boolean(atsResult.remoteEvidenceSnippet);

    if (!hasActivePostings) {
      return {
        stage: 'career_found',
        confidenceScore: 60,
        rejectionReason: 'no_active_postings_found',
      };
    }

    if (hasRemoteJobs) {
      return {
        stage: 'qualified_remote',
        confidenceScore: 90,
        remoteEvidence: atsResult.remoteEvidenceSnippet || 'Verified remote positions on public ATS board',
      };
    }

    return {
      stage: 'career_found',
      confidenceScore: 70,
      rejectionReason: 'no_remote_jobs_identified',
    };
  }

  // 2. Direct Career Page Candidate (Staged for C5)
  if (careerResult && careerResult.found && careerResult.careerUrl) {
    const hasRemoteEvidence = Boolean(careerResult.remoteEvidenceSnippet);
    return {
      stage: hasRemoteEvidence ? 'qualified_remote' : 'career_found',
      confidenceScore: hasRemoteEvidence ? 80 : 65,
      remoteEvidence: careerResult.remoteEvidenceSnippet,
    };
  }

  // 3. No career surface found
  return {
    stage: 'rejected',
    confidenceScore: 30,
    rejectionReason: 'no_career_surface_found',
  };
}

/**
 * Runs a production-scale discovery batch across candidate companies.
 */
export async function runProductionDiscoveryBatch(
  candidates: BatchCandidateInput[],
  config: ProductionPipelineConfig = {}
): Promise<PipelineExecutionMetrics> {
  const concurrency = config.concurrency ?? 10;
  const minConfidence = config.minConfidenceScore ?? 75;
  const maxRateLimitRatio = config.maxRateLimitErrorRatio ?? 0.1;

  const metrics: PipelineExecutionMetrics = {
    totalEvaluated: 0,
    websitesVerified: 0,
    blocklistedCount: 0,
    atsDetectedCount: {
      greenhouse: 0,
      lever: 0,
      ashby: 0,
      total: 0,
    },
    directCareerPageCount: 0,
    qualifiedRemoteCount: 0,
    rejectedCount: 0,
    circuitBreakerTriggered: false,
    rateLimitErrorCount: 0,
    candidates: [],
  };

  const evaluatedCompanies: DiscoveredCompany[] = [];

  for (let i = 0; i < candidates.length; i += concurrency) {
    // Check circuit breaker before starting next batch
    if (metrics.totalEvaluated > 20) {
      const errorRatio = metrics.rateLimitErrorCount / metrics.totalEvaluated;
      if (errorRatio > maxRateLimitRatio) {
        console.warn(`[C6 Pipeline] Circuit breaker triggered! Rate-limit ratio: ${(errorRatio * 100).toFixed(1)}%`);
        metrics.circuitBreakerTriggered = true;
        break;
      }
    }

    const chunk = candidates.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (item) => {
        metrics.totalEvaluated++;

        // 1. Blocklist check
        if (isDomainBlocklisted(item.domain)) {
          metrics.blocklistedCount++;
          metrics.rejectedCount++;
          evaluatedCompanies.push({
            canonicalName: item.name,
            normalizedNameKey: item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
            rawDomain: item.domain,
            discoverySource: (item.source as any) || 'public_registry',
            pipelineStage: 'rejected',
            rejectionReason: 'domain_blocklisted',
            confidenceScore: 0,
          });
          return;
        }

        try {
          // 2. Direct ATS probing
          const atsProbe = await detectAtsEndpoint(item.name, item.domain);

          if (atsProbe.detected && atsProbe.platform) {
            metrics.websitesVerified++;
            metrics.atsDetectedCount[atsProbe.platform]++;
            metrics.atsDetectedCount.total++;

            const qualification = evaluateQualification(
              item,
              { valid: true, rootDomain: item.domain },
              atsProbe
            );

            if (qualification.stage === 'qualified_remote' && qualification.confidenceScore >= minConfidence) {
              metrics.qualifiedRemoteCount++;
            } else if (qualification.stage === 'rejected') {
              metrics.rejectedCount++;
            }

            evaluatedCompanies.push({
              canonicalName: item.name,
              normalizedNameKey: item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
              rawDomain: item.domain,
              resolvedRootDomain: item.domain,
              industry: item.industry,
              discoverySource: (item.source as any) || 'public_registry',
              pipelineStage: qualification.stage,
              discoveredCareerUrl: atsProbe.endpointUrl,
              discoveredAtsPlatform: atsProbe.platform,
              discoveredAtsBoard: atsProbe.boardSlug,
              remoteEvidenceSnippet: qualification.remoteEvidence,
              confidenceScore: qualification.confidenceScore,
              rejectionReason: qualification.rejectionReason,
            });
            return;
          }

          // 3. Fallback: Domain resolution and career finder
          const domainRes = await resolveOfficialDomain(item.domain);
          if (!domainRes.valid || !domainRes.finalUrl) {
            metrics.rejectedCount++;
            evaluatedCompanies.push({
              canonicalName: item.name,
              normalizedNameKey: item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
              rawDomain: item.domain,
              discoverySource: (item.source as any) || 'public_registry',
              pipelineStage: 'rejected',
              rejectionReason: domainRes.rejectionReason || 'domain_unreachable',
              confidenceScore: 0,
            });
            return;
          }

          metrics.websitesVerified++;
          const careerRes = await findCareerSurface(domainRes.finalUrl, item.name);

          const qualification = evaluateQualification(
            item,
            { valid: true, rootDomain: domainRes.resolvedRootDomain, finalUrl: domainRes.finalUrl },
            careerRes.atsResult,
            careerRes
          );

          if (careerRes.atsResult && careerRes.atsResult.platform) {
            metrics.atsDetectedCount[careerRes.atsResult.platform]++;
            metrics.atsDetectedCount.total++;
          } else if (careerRes.found) {
            metrics.directCareerPageCount++;
          }

          if (qualification.stage === 'qualified_remote' && qualification.confidenceScore >= minConfidence) {
            metrics.qualifiedRemoteCount++;
          } else if (qualification.stage === 'rejected') {
            metrics.rejectedCount++;
          }

          evaluatedCompanies.push({
            canonicalName: item.name,
            normalizedNameKey: item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
            rawDomain: item.domain,
            resolvedRootDomain: domainRes.resolvedRootDomain,
            industry: item.industry,
            discoverySource: (item.source as any) || 'public_registry',
            pipelineStage: qualification.stage,
            discoveredCareerUrl: careerRes.careerUrl,
            discoveredAtsPlatform: careerRes.atsResult?.platform || 'none',
            discoveredAtsBoard: careerRes.atsResult?.boardSlug,
            hasJsonLdJobs: careerRes.hasJsonLd,
            robotsPermission: careerRes.robotsAllowed ? 'allowed' : 'unknown',
            remoteEvidenceSnippet: qualification.remoteEvidence,
            confidenceScore: qualification.confidenceScore,
            rejectionReason: qualification.rejectionReason,
          });
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
            metrics.rateLimitErrorCount++;
          }
          metrics.rejectedCount++;
          evaluatedCompanies.push({
            canonicalName: item.name,
            normalizedNameKey: item.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
            rawDomain: item.domain,
            discoverySource: (item.source as any) || 'public_registry',
            pipelineStage: 'rejected',
            rejectionReason: `probe_error: ${errMsg.slice(0, 100)}`,
            confidenceScore: 0,
          });
        }
      })
    );
  }

  metrics.candidates = evaluatedCompanies;

  // Persist to supply_discovered_companies if Supabase admin is configured
  const admin = getSupabaseAdminClient();
  if (admin && evaluatedCompanies.length > 0) {
    try {
      const rowsToUpsert = evaluatedCompanies.map((c) => ({
        canonical_name: c.canonicalName,
        normalized_name_key: c.normalizedNameKey,
        raw_domain: c.rawDomain,
        resolved_root_domain: c.resolvedRootDomain || c.rawDomain,
        industry: c.industry,
        discovery_source: c.discoverySource,
        pipeline_stage: c.pipelineStage,
        rejection_reason: c.rejectionReason,
        discovered_career_url: c.discoveredCareerUrl,
        discovered_ats_platform: c.discoveredAtsPlatform === 'none' || c.discoveredAtsPlatform === 'unknown' ? null : c.discoveredAtsPlatform,
        discovered_ats_board: c.discoveredAtsBoard,
        has_json_ld_jobs: c.hasJsonLdJobs ?? false,
        robots_permission: c.robotsPermission ?? 'unknown',
        remote_evidence_snippet: c.remoteEvidenceSnippet,
        confidence_score: c.confidenceScore ?? 50,
        last_probed_at: new Date().toISOString(),
      }));

      await admin
        .from('supply_discovered_companies')
        .upsert(rowsToUpsert, { onConflict: 'resolved_root_domain' });
    } catch {
      // Staging write failure should not abort discovery results
    }
  }

  return metrics;
}
