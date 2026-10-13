import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getResumeEligibilityRows, asEligibilityOpportunity } from '@/lib/resume/eligibility-index';
import { loadServerProfile } from '@/lib/profile/server-profile';
import {
  selectRelevantOpportunities,
  computeSkillOpportunities,
  normalizeSkillKey,
  type SkillOpportunity,
} from '@/lib/resume/skill-opportunities';

/**
 * Resume Match Opportunities ("Grow your matches", ticket I).
 *
 * GET -> the skills most frequently requested across the caller's RELEVANT
 * jobs (hard-eligible AND target-role-aligned — see selectRelevantOpportunities)
 * that the caller has neither listed nor dismissed, ranked by DISTINCT relevant
 * job count.
 *
 * Rule-based and deterministic. No AI. No raw_resume_text scanning. Reads the
 * frozen `checkHardEligibility` for the relevance filter; never calls the
 * fit-score formula or feed ranking.
 */
const SUGGESTION_LIMIT = 8;

export interface ResumeSkillOpportunitiesResponse {
  success: boolean;
  opportunities: SkillOpportunity[];
  relevantJobCount: number;
}

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  // O9 — profile construction is now the shared loadServerProfile() helper
  // (extracted, byte-identical output to what this route built inline
  // before; see its own doc comment). Behavior-preserving: this route's
  // JSON response shape and content are unchanged.
  //
  // Egress: the catalog side of this route needs only four narrow fields per
  // listing (what checkHardEligibility() and the skill counts read), and it is the
  // same for every caller — so it comes from a shared, cached slim read
  // (src/lib/resume/eligibility-index.ts), not a whole-catalog read per request.
  const [profile, { data: dismissals }, eligibilityRows] = await Promise.all([
    loadServerProfile(supabase, user),
    supabase.from('profile_skill_dismissals').select('skill_key').eq('profile_id', user.id),
    getResumeEligibilityRows(),
  ]);
  const catalog = eligibilityRows.map(asEligibilityOpportunity);

  const skillNames = profile.skills.map((s) => s.skillName);

  const relevant = selectRelevantOpportunities(profile, catalog);

  const ownedSkillKeys = new Set(skillNames.map((n) => normalizeSkillKey(n)));
  const dismissedKeys = new Set((dismissals ?? []).map((d) => d.skill_key as string));

  const opportunities = computeSkillOpportunities({
    relevantOpps: relevant,
    ownedSkillKeys,
    dismissedKeys,
    limit: SUGGESTION_LIMIT,
  });

  const payload: ResumeSkillOpportunitiesResponse = {
    success: true,
    opportunities,
    relevantJobCount: relevant.length,
  };
  return NextResponse.json(payload);
}
