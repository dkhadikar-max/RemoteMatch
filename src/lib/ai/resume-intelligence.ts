import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  PersonProfile,
  CanonicalOpportunity,
  ProfileStrengthAnalysis,
  JobSpecificResumeImprovement,
  AIUncertaintyItem,
  SkillEvidenceLevel,
} from '@/types/byn';

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

// Full AI Resume Intelligence Analysis with Gemini Flash
export async function analyzeResumeWithAI(
  profile: PersonProfile,
  rawResumeText: string
): Promise<ProfileStrengthAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return analyzeResumeHeuristically(profile, rawResumeText);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
You are the Chief Resume Intelligence Officer for RemoteMatch (BYN Architecture).
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

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(result.response.text());
    return parsed;
  } catch (err) {
    console.warn('Gemini Flash Resume Intelligence failed, using heuristic analysis:', err);
    return analyzeResumeHeuristically(profile, rawResumeText);
  }
}

// Generate Job-Specific Resume Improvements
export function generateJobSpecificResumeAnalysis(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity
): JobSpecificResumeImprovement[] {
  const oppSkills = opportunity.requiredSkills.map((s) => s.toLowerCase());
  const resumeText = (profile.rawResumeText || '').toLowerCase();
  const improvements: JobSpecificResumeImprovement[] = [];

  // 1. Re-order recommendation
  const primaryOppSkill = opportunity.requiredSkills[0] || 'Technical Stack';
  improvements.push({
    title: `Move your ${primaryOppSkill} experience higher`,
    currentContext: `The employer specifically requests ${primaryOppSkill} for the ${opportunity.title} role.`,
    recommendation: `Elevate projects and achievements featuring ${primaryOppSkill} into the top third of your resume to immediately establish relevance.`,
    actionType: 'reorder',
  });

  // 2. Bullet rewrite recommendation
  improvements.push({
    title: 'Strengthen impact on execution bullets',
    currentContext: 'Typical current bullet: "Built features and maintained web services."',
    recommendation: `Rewrite using your actual measured outcome, scope, and ownership: "Architected core services handling high concurrency, reducing [insert your metric, e.g. delivery turnaround or latency by X%]."`,
    actionType: 'rewrite',
  });

  // 3. Missing evidence recommendation
  const missingSkill = opportunity.requiredSkills.find((s) => !resumeText.includes(s.toLowerCase()));
  if (missingSkill) {
    improvements.push({
      title: `Surface demonstrated experience with ${missingSkill}`,
      currentContext: `Employer lists ${missingSkill} as a core qualification.`,
      recommendation: `If you have adjacent experience with ${missingSkill}, explicitly mention it in your project notes or cover proposal.`,
      actionType: 'evidence',
    });
  } else {
    improvements.push({
      title: `Highlight ${opportunity.remoteType} async communication`,
      currentContext: 'Employer emphasizes autonomous remote execution.',
      recommendation: `Explicitly detail your cross-timezone documentation, sprint ownership, and async collaboration tools.`,
      actionType: 'evidence',
    });
  }

  return improvements;
}
