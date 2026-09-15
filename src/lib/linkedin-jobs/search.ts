import { PersonProfile, MatchAnalysisResult } from '@/types/byn';
import type { LinkedInJobSearchFilters, LinkedInJobProvenance, DescriptionConfidence } from '@/types/linkedin-jobs';
import { checkHardEligibility, computeScreeningFit, generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
import { normalizeVendorResult } from './normalize';
import { filterToLinkedInResults, SerpApiGoogleJobsVendor, VendorNotConfiguredError, type JobSearchVendor } from './vendor';

/**
 * LinkedIn Job Finder — automated-search orchestration (plan §22 step [1]
 * through [3]). Extracted from the API route so it is directly real-infra-
 * testable with an injected fake JobSearchVendor (see
 * test/linkedin-jobs-vendor-suite.ts) — mirrors this project's existing
 * pattern of keeping the DB-independent/vendor-independent orchestration
 * logic in a lib function the route thinly wraps (e.g.
 * syncCareerPageOpportunities()).
 */

export interface LinkedInSearchResultItem {
  id: string;
  title: string;
  company: string;
  location: string | undefined;
  description: string;
  linkedinUrl: string;
  provenance: LinkedInJobProvenance;
  descriptionConfidence: DescriptionConfidence;
  match: MatchAnalysisResult;
  isEligible: boolean;
}

export interface LinkedInSearchOutcome {
  vendorConfigured: boolean;
  results: LinkedInSearchResultItem[];
}

export async function runLinkedInJobSearch(
  profile: PersonProfile,
  filters: LinkedInJobSearchFilters,
  vendor: JobSearchVendor = new SerpApiGoogleJobsVendor()
): Promise<LinkedInSearchOutcome> {
  let raw;
  try {
    raw = await vendor.search(filters);
  } catch (err) {
    if (err instanceof VendorNotConfiguredError) {
      // Fails safe (plan §22's operational-dependency requirement): no
      // vendor key provisioned yet is a known, expected state in this
      // implementation pass, not a server error.
      return { vendorConfigured: false, results: [] };
    }
    console.warn('[linkedin-jobs] vendor search failed:', err);
    return { vendorConfigured: true, results: [] };
  }

  const linkedInOnly = filterToLinkedInResults(raw);

  const results: LinkedInSearchResultItem[] = linkedInOnly.map((vendorJob) => {
    const { opportunity, provenance, descriptionConfidence, linkedinUrl } = normalizeVendorResult(vendorJob);
    const gate = checkHardEligibility(profile, opportunity);
    const match = generateRuleBasedMatchAnalysis(profile, opportunity);
    const careerTransition = classifyCareerTransition(profile, opportunity, gate.isEligible);
    return {
      id: opportunity.id,
      title: opportunity.title,
      company: opportunity.company,
      location: vendorJob.location,
      description: opportunity.description,
      linkedinUrl,
      provenance,
      descriptionConfidence,
      match: careerTransition ? { ...match } : match,
      isEligible: gate.isEligible,
    };
  });

  // Best fit first — same ordering convention as scoreOpportunitiesForFeed.
  results.sort((a, b) => b.match.fitScore - a.match.fitScore);

  return { vendorConfigured: true, results };
}

// Re-exported so callers (the route, tests) that need computeScreeningFit's
// lighter shape for a single ad-hoc job (e.g. the "paste a job" flow, which
// doesn't need the full search orchestration above) don't have to import
// engine.ts separately.
export { computeScreeningFit };
