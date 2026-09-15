import { PersonProfile, MatchAnalysisResult } from '@/types/byn';
import type { PastedJobInput, DescriptionConfidence } from '@/types/linkedin-jobs';
import { checkHardEligibility, generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
import { normalizePastedJob } from './normalize';

/**
 * LinkedIn Job Finder — "paste a job" analysis (plan §22 step [1b], §26
 * Mode B, always Free per plan §27). No vendor call, no quota, no spend —
 * matching reuse only, identical downstream path to the automated-search
 * results in search.ts.
 */
export interface PastedJobAnalysis {
  id: string;
  title: string;
  company: string;
  description: string;
  linkedinUrl: string;
  descriptionConfidence: DescriptionConfidence;
  match: MatchAnalysisResult;
  isEligible: boolean;
}

export function analyzePastedJob(profile: PersonProfile, input: PastedJobInput): PastedJobAnalysis {
  const { opportunity, descriptionConfidence, linkedinUrl } = normalizePastedJob(input);
  const gate = checkHardEligibility(profile, opportunity);
  const match = generateRuleBasedMatchAnalysis(profile, opportunity);
  // classifyCareerTransition's result is additive-only and already folded
  // into `match`'s caller-facing shape the same way feed/route.ts does it —
  // kept as a distinct call here (not silently dropped) so a future UI can
  // surface it exactly like the catalog Match Detail page does.
  classifyCareerTransition(profile, opportunity, gate.isEligible);

  return {
    id: opportunity.id,
    title: opportunity.title,
    company: opportunity.company,
    description: opportunity.description,
    linkedinUrl,
    descriptionConfidence,
    match,
    isEligible: gate.isEligible,
  };
}
