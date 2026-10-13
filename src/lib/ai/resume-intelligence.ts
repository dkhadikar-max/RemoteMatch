// AI Phase 1B provider switch (docs/ai-phase1b-implementation-plan.md,
// locked §7.2). Was Gemini; is now OpenAI (`gpt-5-mini` via
// openai-config.ts). This file's real-AI path is STILL structurally
// unreachable in production (ticket O5's HELD finding: called from
// onboarding client-side, where any `*_API_KEY` env var is always
// undefined there), independent of which provider is configured — stays
// exactly as HELD, NOT resolved by this change, same mechanical-swap-only
// discipline as the earlier Gemini-model-id cleanup this file already went
// through (docs/gemini-compatibility-remediation-spec.md §5).
import { getOpenAiClient, OPENAI_MODEL_ID, OPENAI_REASONING_EFFORT } from './openai-config';
import { skillAppearsInText } from '@/lib/resume/skill-evidence';
import { reserveOpenAiSpend, consumeOpenAiSpend } from './spend-ledger';
import { recordAiCallEvent, type AiCallOutcome } from '@/lib/observability/ai-events';
import {
  PersonProfile,
  CanonicalOpportunity,
  ProfileStrengthAnalysis,
  JobSpecificResumeImprovement,
  AIUncertaintyItem,
  SkillEvidenceLevel,
} from '@/types/byn';

function classifyOpenAiError(err: unknown): AiCallOutcome {
  const status = (err as { status?: number })?.status;
  if (status === 429) return 'rate_limited_429';
  if (status === 404) return 'model_not_found_404';
  if (status && status >= 500) return 'service_unavailable_503';
  return 'other';
}

/**
 * @deprecated NOT WIRED INTO ANY PRODUCTION PATH. Onboarding no longer calls this (it uses the facts-only
 * src/lib/resume/resume-check.ts). Its output is largely hard-coded text (audit R-P0-1: gibberish scores 48/100 with
 * "Clean chronological formatting"), it throws on skills such as "C++" (R-P1-1) and mislabels C#/.NET/Go (R-P1-2).
 * Kept ONLY because test/verification-suite.ts, gate3-ai-factuality.ts and staging-smoke-test.ts still exercise it;
 * do not call it from application code. Planned removal with those tests (see docs/resume-analysis-remediation-proposal.md).
 */
// Fallback rule-based analyzer
export function analyzeResumeHeuristically(
  profile: PersonProfile,
  rawResumeText: string
): ProfileStrengthAnalysis {
  const textLower = rawResumeText.toLowerCase();
  const claimedSkills = profile.skills.map((s) => s.skillName);
  const targetRoles = profile.intent?.targetRoles || ['Software Engineer'];

  // 1. Evidence evaluation for each claimed skill
  const uncertainties: AIUncertaintyItem[] = [];
  let strongCount = 0;
  let missingCount = 0;

  for (const skill of claimedSkills) {
    const pattern = new RegExp(`\\b${skill.replace('.', '\\.')}\\b`, 'i');
    if (pattern.test(textLower)) {
      strongCount++;
    } else {
      missingCount++;
      uncertainties.push({
        id: `uncert-${skill.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        skill,
        prompt: `We couldn't find evidence of ${skill} experience in your resume. Do you have this experience?`,
        resolved: false,
      });
    }
  }

  // 2. Impact check: Presence of numbers, %, $, or scale metrics (excluding calendar years)
  const rawMetricMatches = rawResumeText.match(/(\d+%\b|\$\d+|\b\d+(?:k|m|b)\b|\b\d{2,}\b|\bscale\b|\bgrowth\b|\brevenue\b)/gi) || [];
  const metricMatches = rawMetricMatches.filter((m) => !/^(19\d\d|20\d\d)$/.test(m.trim()));
  const impactScore = Math.min(Math.max(metricMatches.length * 15 + 40, 45), 95);

  // 3. Relevance check: Target roles mentioned or supported
  const roleMatches = targetRoles.filter((r) => {
    const tokens = r.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return tokens.some((t) => textLower.includes(t));
  });
  const relevanceScore = Math.min(Math.max(roleMatches.length * 25 + 50, 50), 96);

  // 4. Evidence score
  const totalSkills = Math.max(claimedSkills.length, 1);
  const evidenceRatio = strongCount / totalSkills;
  const evidenceScore = Math.round(evidenceRatio * 40 + 50);

  // 5. ATS & Readability
  const hasDates = /\b(20\d\d|19\d\d|present)\b/i.test(rawResumeText);
  const hasSections = /\b(experience|education|skills|projects|summary)\b/i.test(textLower);
  const atsScore = (hasDates ? 45 : 20) + (hasSections ? 45 : 20);

  // 6. Target Alignment
  const targetScore = Math.round((relevanceScore + evidenceScore) / 2);

  // Overall Profile Strength (0-100)
  const overallScore = Math.round(
    relevanceScore * 0.25 +
    evidenceScore * 0.25 +
    impactScore * 0.2 +
    atsScore * 0.15 +
    targetScore * 0.15
  );

  const strongAreas = claimedSkills.filter((s) => textLower.includes(s.toLowerCase())).slice(0, 4);
  if (strongAreas.length === 0) strongAreas.push('Core domain foundation', 'Remote collaboration');

  const improvementAreas = [
    {
      title: 'Strengthen Target Role Evidence',
      explanation: `Your target role (${targetRoles[0] || 'Target Role'}) requires clear strategic scope, but your resume currently emphasizes execution over leadership.`,
      action: 'Elevate architecture decisions and cross-functional ownership in your recent role.',
    },
    {
      title: 'Add Measurable Outcomes',
      explanation: 'Several experience points describe responsibilities without showing business impact or metrics.',
      action: 'Add percentages, latency improvements, user scale, or delivery speed outcomes.',
    },
    {
      title: 'Surface Underrepresented Capabilities',
      explanation: uncertainties.length > 0
        ? `You selected ${uncertainties.map((u) => u.skill).slice(0, 2).join(', ')} during onboarding, but they lack prominent evidence.`
        : 'Ensure your most valuable frameworks appear in the top half of your resume.',
      action: 'Confirm where you used these tools or add project references.',
    },
  ];

  return {
    overallScore: Math.min(Math.max(overallScore, 40), 98),
    dimensions: {
      relevance: {
        name: 'Relevance',
        score: relevanceScore,
        feedback: roleMatches.length > 0
          ? 'Strong alignment with your selected target roles.'
          : 'Consider refining role titles to match current remote market standards.',
      },
      evidence: {
        name: 'Evidence',
        score: evidenceScore,
        feedback: `${strongCount} of ${totalSkills} claimed skills are clearly demonstrated in your text.`,
      },
      impact: {
        name: 'Impact & Metrics',
        score: impactScore,
        feedback: metricMatches.length >= 2
          ? 'Good use of quantifiable metrics and business impact.'
          : 'Bullet points would be significantly stronger with measurable results.',
      },
      atsReadability: {
        name: 'ATS & Readability',
        score: atsScore,
        feedback: 'Clean chronological formatting and standard industry terminology.',
      },
      targetAlignment: {
        name: 'Target Alignment',
        score: targetScore,
        feedback: 'Good baseline positioning for high-signal remote opportunities.',
      },
    },
    strongAreas,
    improvementAreas,
    uncertainties: uncertainties.slice(0, 3),
  };
}

/**
 * @deprecated NOT WIRED INTO ANY PRODUCTION PATH. It was only ever callable from the browser, where the API key is
 * undefined, so it always fell back to analyzeResumeHeuristically (see above). Its parsed model output is returned
 * without schema validation. Do not call it from application code; server-side, quote-verified extraction is
 * proposed instead (docs/resume-analysis-remediation-proposal.md, phase P3).
 */
// Full AI Resume Intelligence Analysis (OpenAI gpt-5-mini)
export async function analyzeResumeWithAI(
  profile: PersonProfile,
  rawResumeText: string
): Promise<ProfileStrengthAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return analyzeResumeHeuristically(profile, rawResumeText);
  }

  const MAX_COMPLETION_TOKENS = 1500;

  const prompt = `
You are the Chief Resume Intelligence Officer for RemoteMatch.
Analyze this candidate's resume text against their onboarding intent.

Candidate Claimed Intent:
- Target Roles: ${profile.intent?.targetRoles.join(', ') || 'Software Engineer'}
- Claimed Skills: ${profile.skills.map((s) => s.skillName).join(', ')}
- Years of Experience: ${profile.intent?.yearsOfExperience || '2-3'}
- Location: ${profile.location?.currentCountry || 'Worldwide'}

Resume Text:
"""
${rawResumeText.slice(0, 3500)}
"""

Evaluate 5 dimensions (0-100 each):
1. Relevance (Does resume support target roles?)
2. Evidence (Does resume actually demonstrate claimed skills?)
3. Impact (Does experience show measurable results? Revenue, scale, users, speed?)
4. ATS Readability (Dates, titles, formatting consistency?)
5. Target Alignment (Keywords, positioning?)

Identify if any claimed skills have MISSING evidence in the resume text so we can resolve uncertainty.
Never fabricate metrics or employers. Suggest: "This bullet would be stronger with a measurable result."

Output ONLY valid JSON matching this schema:
{
  "overallScore": 78,
  "dimensions": {
    "relevance": { "name": "Relevance", "score": 82, "feedback": "Feedback string" },
    "evidence": { "name": "Evidence", "score": 75, "feedback": "Feedback string" },
    "impact": { "name": "Impact & Metrics", "score": 70, "feedback": "Feedback string" },
    "atsReadability": { "name": "ATS & Readability", "score": 85, "feedback": "Feedback string" },
    "targetAlignment": { "name": "Target Alignment", "score": 78, "feedback": "Feedback string" }
  },
  "strongAreas": ["Product management", "TypeScript", "SaaS", "Async collaboration"],
  "improvementAreas": [
    {
      "title": "Area Title",
      "explanation": "Why this area needs improvement",
      "action": "Concrete action to take"
    }
  ],
  "uncertainties": [
    {
      "id": "uncert-skillname",
      "skill": "Skill Name",
      "prompt": "We couldn't find evidence of Skill in your resume. Do you have this experience?",
      "resolved": false
    }
  ]
}
`;

  const reservation = await reserveOpenAiSpend('resume_intelligence', prompt, MAX_COMPLETION_TOKENS);
  if (!reservation.allowed) {
    return analyzeResumeHeuristically(profile, rawResumeText);
  }
  const { usagePeriod, reservedCostUsd } = reservation as { usagePeriod: string; reservedCostUsd: number };
  const startedAt = Date.now();

  // Two explicit stages (Phase 1A/1B pattern): consume exactly once, right
  // after the API call resolves, never a second time if a post-success
  // JSON.parse subsequently fails.
  let completion;
  try {
    const client = getOpenAiClient();
    completion = await client.chat.completions.create({
      model: OPENAI_MODEL_ID,
      // See openai-config.ts's header for why omitting this is not an
      // option — a real, live-verified failure mode (empty output).
      reasoning_effort: OPENAI_REASONING_EFFORT,
      response_format: { type: 'json_object' },
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    const failedConsume = await consumeOpenAiSpend('resume_intelligence', usagePeriod, reservedCostUsd);
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_intelligence',
      outcome: classifyOpenAiError(err), latencyMs: Date.now() - startedAt,
      estimatedCostUsd: failedConsume.actualCostUsd,
    });
    console.warn('OpenAI Resume Intelligence call failed, using heuristic analysis:', err);
    return analyzeResumeHeuristically(profile, rawResumeText);
  }

  const usage = completion.usage;
  // Use the RECONCILED actual cost, never reservedCostUsd — see
  // OpenAiConsumeResult's doc comment in spend-ledger.ts.
  const { actualCostUsd, tokensUsed } = await consumeOpenAiSpend(
    'resume_intelligence', usagePeriod, reservedCostUsd, usage?.prompt_tokens, usage?.completion_tokens
  );

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '');
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_intelligence',
      outcome: 'success', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    return parsed;
  } catch (err) {
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_intelligence',
      outcome: 'malformed_response', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    console.warn('OpenAI Resume Intelligence returned unparseable JSON, using heuristic analysis:', err);
    return analyzeResumeHeuristically(profile, rawResumeText);
  }
}

/**
 * Job-specific resume suggestions — DERIVED FROM DATA, never invented (P1b; audit R-P2-2).
 *
 * The only inputs are the job's required skills, the user's DECLARED skills and the user's resume text. Every
 * suggestion states a fact it can check and what to do about it; nothing describes the user's bullets, employers or
 * metrics, and there is no template text:
 *   - evidence: the skill is on the profile but the resume text does not mention it → make it visible
 *   - evidence: the job requires a skill that is not on the profile → add it if you have used it
 *   - reorder : the resume text mentions a skill the job requires → keep it easy to find
 * With no resume text (or one too short to judge) no claim about the resume is made. At most 3 are returned; an
 * empty list is a valid answer (the view says so honestly).
 */
const MIN_RESUME_WORDS_FOR_SUGGESTIONS = 8;

export function generateJobSpecificResumeAnalysis(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): JobSpecificResumeImprovement[] {
  const required: string[] = [];
  for (const raw of opportunity.requiredSkills ?? []) {
    const skill = typeof raw === 'string' ? raw.trim() : '';
    if (skill && !required.some((r) => r.toLowerCase() === skill.toLowerCase())) required.push(skill);
    if (required.length >= 8) break;
  }
  const declared = (profile.skills ?? []).map((s) => s.skillName).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const resumeText = typeof profile.rawResumeText === 'string' ? profile.rawResumeText : '';
  const resumeUsable = resumeText.trim().split(/\s+/).filter(Boolean).length >= MIN_RESUME_WORDS_FOR_SUGGESTIONS;

  const listedNotInResume: string[] = [];
  const notOnProfile: string[] = [];
  const inResume: string[] = [];
  for (const skill of required) {
    const onProfile = declared.some((d) => skillAppearsInText(skill, d));
    const inResumeText = resumeUsable && skillAppearsInText(skill, resumeText);
    if (inResumeText) inResume.push(skill);
    else if (onProfile && resumeUsable) listedNotInResume.push(skill);
    if (!onProfile) notOnProfile.push(skill);
  }

  const improvements: JobSpecificResumeImprovement[] = [];
  for (const skill of listedNotInResume.slice(0, 2)) {
    improvements.push({
      title: `Make ${skill} visible on your resume`,
      currentContext: 'Listed on your profile; not found in your resume text.',
      recommendation: `This role asks for ${skill}. If you have used it, make sure your resume shows where.`,
      actionType: 'evidence',
    });
  }
  for (const skill of notOnProfile.slice(0, 1)) {
    improvements.push({
      title: `Add ${skill} to your profile if you have used it`,
      currentContext: 'Required by this listing; not on your profile.',
      recommendation: `This role asks for ${skill}, which isn't on your profile. If you have experience with it, add it to your skills.`,
      actionType: 'evidence',
    });
  }
  for (const skill of inResume.slice(0, 1)) {
    improvements.push({
      title: `Keep ${skill} easy to find on your resume`,
      currentContext: 'Found in your resume text.',
      recommendation: `This role asks for ${skill} and your resume text mentions it — keep it near the top so it is easy to spot.`,
      actionType: 'reorder',
    });
  }
  return improvements.slice(0, 3);
}
