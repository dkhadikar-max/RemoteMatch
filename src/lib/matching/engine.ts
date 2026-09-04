import {
  CanonicalOpportunity,
  PersonProfile,
  EligibilityGateResult,
  ScreeningFitResult,
  MatchAnalysisResult,
  RequirementCheckItem,
} from '@/types/byn';

// ==============================================================================
// 1. HARD ELIGIBILITY GATE
// Evaluates before computing Fit Score:
// Candidate country -> Remote type -> Employment type -> Role relevance
// ==============================================================================
export function checkHardEligibility(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): EligibilityGateResult {
  const intent = profile.intent;
  const location = profile.location;

  const candidateCountry = (location?.currentCountry || 'Worldwide').toLowerCase();
  const workPreference = location?.workPreference || 'worldwide';

  // A. Country & Remote Type Eligibility
  let countryEligible = true;
  let ineligibilityReason: string | undefined;

  if (opportunity.remoteType === 'US') {
    if (candidateCountry !== 'us' && candidateCountry !== 'united states' && candidateCountry !== 'usa') {
      countryEligible = false;
      ineligibilityReason = 'Requires US residency / authorization.';
    }
  } else if (opportunity.remoteType === 'EU/EEA') {
    const isEuCandidate = ['uk', 'germany', 'france', 'spain', 'netherlands', 'sweden', 'ireland', 'poland', 'europe'].includes(candidateCountry);
    if (!isEuCandidate) {
      countryEligible = false;
      ineligibilityReason = 'Restricted to EU/EEA or UK timezones.';
    }
  } else if (opportunity.remoteType === 'India') {
    if (candidateCountry !== 'india' && candidateCountry !== 'in') {
      countryEligible = false;
      ineligibilityReason = 'Restricted to India residency.';
    }
  }

  // B. Remote Actually Allowed
  const remoteAllowed = (opportunity.remoteType || 'Worldwide') !== 'Specific countries' || countryEligible;

  // C. Employment Type Compatibility
  let employmentTypeCompatible = true;
  if (intent && intent.employmentTypes && intent.employmentTypes.length > 0) {
    const oppType = (opportunity.employmentType || 'Full-time').toLowerCase();
    const candidateTypes = intent.employmentTypes.map((t) => t.toLowerCase().replace('-', '_'));

    const matchFound = candidateTypes.some((t) => {
      if (t === 'full_time' && oppType.includes('full')) return true;
      if (t === 'contract' && oppType.includes('contract')) return true;
      if (t === 'freelance' && (oppType.includes('freelance') || oppType.includes('contract'))) return true;
      if (t === 'part_time' && oppType.includes('part')) return true;
      return false;
    });

    if (!matchFound && candidateTypes.length > 0) {
      employmentTypeCompatible = false;
      if (!ineligibilityReason) {
        ineligibilityReason = `Job is ${opportunity.employmentType || 'different type'}, which does not match your intent.`;
      }
    }
  }

  // D. Role Relevance
  let roleRelevant = true;
  if (intent && intent.targetRoles && intent.targetRoles.length > 0) {
    const GENERIC_ROLE_TOKENS = new Set([
      'engineer',
      'developer',
      'software',
      'specialist',
      'manager',
      'lead',
      'senior',
      'junior',
      'staff',
      'principal',
      'architect',
      'associate',
      'head',
      'director',
      'vp',
      'officer',
      'intern',
      'contractor',
      'consultant',
      'expert',
      'role',
    ]);

    const titleLower = opportunity.title.toLowerCase();
    const oppSkillsLower = (opportunity.requiredSkills || []).map((s) => s.toLowerCase());
    const oppText = `${titleLower} ${oppSkillsLower.join(' ')}`;
    const candidateSkillNames = (profile.skills || []).map((s) => s.skillName.toLowerCase());

    const hasRoleKeyword = intent.targetRoles.some((targetRole) => {
      const allTokens = targetRole.toLowerCase().split(/[\s\/-]+/).filter((w) => w.length > 1);
      const substantiveTokens = allTokens.filter((token) => !GENERIC_ROLE_TOKENS.has(token));

      if (substantiveTokens.length > 0) {
        // Must match at least one specific domain token (e.g. 'data', 'mobile', 'frontend', 'ai')
        return substantiveTokens.some((token) => oppText.includes(token));
      }

      // If target title was purely generic (e.g. 'Software Engineer'), check skill overlap
      return candidateSkillNames.some((sk) =>
        oppSkillsLower.some((oppSk) => oppSk.includes(sk) || sk.includes(oppSk))
      );
    });

    if (!hasRoleKeyword && intent.targetRoles.length > 0) {
      roleRelevant = false;
      if (!ineligibilityReason) {
        ineligibilityReason = 'Role differs significantly from your target titles.';
      }
    }
  }

  const isEligible = countryEligible && remoteAllowed && employmentTypeCompatible && roleRelevant;

  return {
    isEligible,
    countryEligible,
    remoteAllowed,
    employmentTypeCompatible,
    roleRelevant,
    ineligibilityReason,
  };
}

// ==============================================================================
// 2. FAST SCREENING FIT SCORE (For Swipe Feed)
// Incorporates skill evidence levels (strong vs missing)
// ==============================================================================
export function computeScreeningFit(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): ScreeningFitResult {
  const gate = checkHardEligibility(profile, opportunity);

  if (!gate.isEligible) {
    return {
      fitScore: 28,
      fitBadge: 'Low Fit',
      overlapSkills: [],
      missingSkills: opportunity.requiredSkills.slice(0, 3),
    };
  }

  const candidateSkills = profile.skills;
  const oppSkills = opportunity.requiredSkills.map((s) => s.toLowerCase());
  const oppText = `${opportunity.title} ${opportunity.description} ${oppSkills.join(' ')}`.toLowerCase();

  const overlapSkills: string[] = [];
  const missingSkills: string[] = [];
  let evidenceScoreBonus = 0;

  for (const sk of oppSkills) {
    const matchedProfileSkill = candidateSkills.find(
      (cs) => cs.skillName.toLowerCase().includes(sk) || sk.includes(cs.skillName.toLowerCase())
    );

    if (matchedProfileSkill) {
      overlapSkills.push(matchedProfileSkill.skillName);
      // Evidence level weighting
      if (matchedProfileSkill.evidenceLevel === 'strong') {
        evidenceScoreBonus += 5;
      } else if (matchedProfileSkill.evidenceLevel === 'missing') {
        evidenceScoreBonus += 1;
      } else {
        evidenceScoreBonus += 3;
      }
    } else {
      missingSkills.push(sk);
    }
  }

  // Skill match points
  const totalChecked = Math.max(oppSkills.length, 3);
  const skillRatio = Math.min(overlapSkills.length / totalChecked, 1);
  const skillPoints = Math.round(skillRatio * 40) + Math.min(evidenceScoreBonus, 10);

  // Experience points
  let expPoints = 20;
  const candidateExp = profile.intent?.yearsOfExperience || '2-3';
  const reqExp = opportunity.experienceRequirement || '2-3';
  if (candidateExp === reqExp || candidateExp === '7-10' || candidateExp === '10+') {
    expPoints = 25;
  } else if (candidateExp === '0-1' && (reqExp === '7-10' || reqExp === '10+')) {
    expPoints = 8;
  }

  // Base
  let basePoints = 20;
  if (opportunity.remoteType === 'Worldwide') basePoints += 5;

  const rawScore = Math.min(Math.max(skillPoints + expPoints + basePoints, 35), 98);

  let fitBadge: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Low Fit' = 'Moderate Fit';
  if (rawScore >= 80) fitBadge = 'Strong Fit';
  else if (rawScore >= 65) fitBadge = 'Good Fit';
  else if (rawScore >= 50) fitBadge = 'Moderate Fit';
  else fitBadge = 'Low Fit';

  return {
    fitScore: rawScore,
    fitBadge,
    overlapSkills: overlapSkills.slice(0, 6),
    missingSkills: missingSkills.slice(0, 4),
  };
}

// ==============================================================================
// 3. DEEP MATCH ANALYSIS
// ==============================================================================
export function generateRuleBasedMatchAnalysis(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): MatchAnalysisResult {
  const gate = checkHardEligibility(profile, opportunity);
  const screening = computeScreeningFit(profile, opportunity);

  const candidateSkills = profile.skills;
  const oppSkills = opportunity.requiredSkills.length > 0 ? opportunity.requiredSkills : ['Remote Collaboration', 'Communication'];

  const checklist: RequirementCheckItem[] = [];
  const strengths: string[] = [];
  const gaps: string[] = [];

  for (const req of oppSkills) {
    const matchedProfileSkill = candidateSkills.find(
      (cs) => cs.skillName.toLowerCase().includes(req.toLowerCase()) || req.toLowerCase().includes(cs.skillName.toLowerCase())
    );

    if (matchedProfileSkill) {
      const isStrong = matchedProfileSkill.evidenceLevel === 'strong';
      checklist.push({
        requirement: req,
        status: isStrong ? 'matched' : 'partial',
        note: isStrong
          ? `Verified competency with demonstrated project evidence.`
          : `Claimed skill in profile; ensure resume highlights recent use.`,
      });
      strengths.push(`Core capability in ${req} (${isStrong ? 'Strong Evidence' : 'Verified'})`);
    } else {
      checklist.push({
        requirement: req,
        status: 'missing',
        note: `Not explicitly listed in your profile; highlight adjacent experience.`,
      });
      gaps.push(`No demonstrated experience with ${req}`);
    }
  }

  const userExp = profile.intent?.yearsOfExperience || '2-3';
  checklist.push({
    requirement: `${opportunity.experienceRequirement || '2-3'} years experience`,
    status: 'matched',
    note: `Your background matches the ${userExp} years seniority tier.`,
  });
  strengths.push(`${userExp} years relevant experience aligns with team expectations.`);

  checklist.push({
    requirement: `${opportunity.remoteType} Remote Work Eligibility`,
    status: gate.countryEligible ? 'matched' : 'missing',
    note: gate.countryEligible ? 'Location and work scope fully satisfied.' : 'Geographic or timezone restriction caveat.',
  });

  if (gate.countryEligible) {
    strengths.push(`Location flexibility (${opportunity.remoteType}) verified for your region.`);
  } else {
    gaps.push(`Geographic restriction: ${opportunity.remoteType}`);
  }

  const whyThisJob = `You match ${strengths.length} key attributes including core capabilities (${screening.overlapSkills.slice(0, 3).join(', ') || 'domain alignment'}) and remote eligibility. ${
    gaps.length > 0 ? `Your primary gap to address is ${gaps[0].toLowerCase()}.` : 'You satisfy all primary criteria.'
  }`;

  let recommendation: 'apply' | 'apply_with_caveat' | 'low_priority' = 'apply';
  if (!gate.isEligible || screening.fitScore < 50) {
    recommendation = 'low_priority';
  } else if (screening.fitScore < 75 || gaps.length > 1) {
    recommendation = 'apply_with_caveat';
  } else {
    recommendation = 'apply';
  }

  return {
    opportunityId: opportunity.id,
    fitScore: screening.fitScore,
    fitBadge: screening.fitBadge,
    isCountryEligible: gate.countryEligible,
    isRemoteEligible: gate.remoteAllowed,
    isRoleMatch: gate.roleRelevant,
    whyThisJob,
    strengths: strengths.slice(0, 5),
    gaps: gaps.slice(0, 4),
    requirementChecklist: checklist,
    recommendation,
  };
}
