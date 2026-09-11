import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  CanonicalOpportunity,
  PersonProfile,
  MatchAnalysisResult,
  TailoredResumeSuggestions,
  MaterialTone,
} from '@/types/byn';
import { deriveActionableSkillGaps } from '@/lib/match/actionable-skill-gaps';
import { isGeneratedKitSupported } from '@/lib/ai/anti-fabrication';

/** Where the returned material actually came from (ticket O3). 'template'
 *  means the deterministic, hand-authored generator — including when an
 *  AI attempt was made but rejected by the anti-fabrication check (O4).
 *  Never persisted (kept OUT of TailoredResumeSuggestions itself, which is
 *  also the shape stored in the frozen decision_snapshot — O2). */
export type ApplicationKitSource = 'ai' | 'template';

// Fallback high-quality template generator
function generateFallbackApplicationKit(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity,
  match: MatchAnalysisResult,
  tone: MaterialTone = 'confident'
): {
  resumeTweaks: TailoredResumeSuggestions;
  coverLetter: string;
  source: ApplicationKitSource;
} {
  const candidateName = profile.fullName || 'Candidate';
  const roleTitle = opportunity.title;
  const company = opportunity.company;
  const topSkills = profile.skills.slice(0, 3).map((s) => s.skillName).join(', ') || 'modern software development';
  const topOverlap = match.strengths[0] || `Deep experience with ${topSkills}`;

  const resumeTweaks: TailoredResumeSuggestions = {
    summaryAdjustment: `Targeted for ${company}: Highlight your track record in ${topSkills} and remote collaboration, emphasizing measurable business outcomes.`,
    emphasizeExperience: [
      `Elevate ${match.strengths.slice(0, 2).join(' and ')} to the top third of your resume.`,
      `Quantify system scale or user adoption metrics under your most recent role.`,
      `Feature ${opportunity.remoteType} async communication leadership prominently.`,
    ],
    bulletRewrites: [
      {
        originalContext: 'Worked on feature engineering and web applications.',
        suggestedRewrite: `Spearheaded feature delivery using ${topSkills}, improving [insert your measured outcome, e.g. latency, user volume, or conversion] across distributed teams.`,
        targetRequirement: opportunity.requiredSkills[0] || 'Technical Leadership',
      },
      {
        originalContext: 'Collaborated with cross-functional partners remotely.',
        suggestedRewrite: `Partnered asynchronously with product, design, and engineering stakeholders to ship critical roadmaps [insert your delivery timeline or impact].`,
        targetRequirement: 'Async Remote Work',
      },
    ],
    recommendedSkillsToAdd: match.gaps.slice(0, 2).map((g) => g.replace('No demonstrated experience with ', '')),
  };

  let coverLetter = '';
  if (tone === 'confident') {
    coverLetter = `Hi ${company} Team,

I'm writing to express my strong interest in the ${roleTitle} role. Having followed ${company}'s journey, I am energized by your product focus and remote-first culture.

Over the past ${profile.intent?.yearsOfExperience || 'several'} years, I have built and delivered high-impact products specializing in ${topSkills}. My background directly aligns with what you are seeking:
• ${match.strengths[0] || `Proven expertise building scalable solutions with ${topSkills}.`}
• ${match.strengths[1] || 'Track record of driving execution independently in asynchronous remote environments.'}
• Strong dedication to craft, clean architecture, and user-centric problem solving.

I would love the opportunity to contribute to ${company}'s next phase of growth. Looking forward to discussing how my experience can deliver immediate momentum to your team.

Best regards,
${candidateName}`;
  } else if (tone === 'conversational') {
    coverLetter = `Hey ${company} team!

I saw the ${roleTitle} opening and immediately felt this was an exceptional match. 

My work centers around ${topSkills}. What excites me most about this opportunity with ${company} is the chance to solve hard problems with a high-trust, autonomous remote team.

Here is a quick snapshot of how I can jump in on day one:
- ${match.strengths[0] || `Deep hands-on experience in ${topSkills}`}
- ${match.strengths[1] || 'Comfortable owning features end-to-end from ambiguity to deployment'}
- Consistent async communicator who thrives without micromanagement

I'd be thrilled to connect for a quick intro chat to explore how we might work together.

Cheers,
${candidateName}`;
  } else {
    // Formal
    coverLetter = `Dear Hiring Team at ${company},

Please accept this letter as an application for the ${roleTitle} position. With comprehensive professional experience in ${topSkills}, I am confident in my ability to make a valuable and lasting contribution to ${company}.

Throughout my career, I have consistently achieved measurable milestones:
1. ${match.strengths[0] || `Delivered core technical initiatives utilizing ${topSkills}.`}
2. ${match.strengths[1] || 'Established robust, maintainable workflows within distributed global teams.'}
3. Spearheaded cross-functional delivery while maintaining high standards of quality and execution.

Thank you for your time and consideration. I welcome the opportunity to discuss my qualifications in greater detail.

Sincerely,
${candidateName}`;
  }

  return { resumeTweaks, coverLetter, source: 'template' };
}

// Generate application kit with Gemini Flash or intelligent fallback
export async function generateApplicationKit(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity,
  match: MatchAnalysisResult,
  tone: MaterialTone = 'confident'
): Promise<{
  resumeTweaks: TailoredResumeSuggestions;
  coverLetter: string;
  source: ApplicationKitSource;
}> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return generateFallbackApplicationKit(profile, opportunity, match, tone);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
You are an expert career strategist for RemoteMatch.
Generate a tailored Application Kit for this candidate applying to this specific remote opportunity.

CRITICAL INVARIANT: The model may transform evidence, but may NOT manufacture evidence.
1. DO NOT invent metrics, percentages, revenue amounts, scale numbers, or team sizes. If metrics are missing, use explicit placeholders like [insert metric, e.g. % improvement] or coach candidate to quantify.
2. DO NOT invent past employers, job titles, responsibilities, or certifications not listed in Candidate Profile.
3. DO NOT invent technologies or frameworks not demonstrated by candidate.
4. Distinguish clearly between:
   - Evidence explicitly exists -> Can recommend / rewrite
   - Evidence is ambiguous -> Qualify / ask candidate
   - Evidence absent -> FORBIDDEN to claim

Candidate Profile:
- Name: ${profile.fullName}
- Experience Level: ${profile.intent?.yearsOfExperience || '2-3'} years
- Core Skills: ${profile.skills.map((s) => s.skillName).join(', ')}
- Location: ${profile.location?.currentCountry || 'Worldwide'}
- Stated Achievements: ${profile.experiences.flatMap((e) => e.achievements).join('; ') || 'None provided'}

Opportunity:
- Company: ${opportunity.company}
- Title: ${opportunity.title}
- Remote Type: ${opportunity.remoteType}
- Requirements: ${opportunity.requiredSkills.join(', ')}
- Description Excerpt: ${opportunity.description.slice(0, 800)}

Match Intelligence:
- Strengths: ${match.strengths.join('; ')}
- Gaps: ${match.gaps.join('; ')}
- Desired Tone: ${tone} (Options: confident, conversational, formal)

Output ONLY valid JSON with this exact schema:
{
  "resumeTweaks": {
    "summaryAdjustment": "1-2 sentence positioning statement tweak",
    "emphasizeExperience": ["tip 1", "tip 2", "tip 3"],
    "bulletRewrites": [
      {
        "originalContext": "short description of typical experience",
        "suggestedRewrite": "truthful rewrite grounded in candidate evidence with placeholders for unstated metrics",
        "targetRequirement": "requirement from job"
      }
    ],
    "recommendedSkillsToAdd": ["skill1", "skill2"]
  },
  "coverLetter": "concise, zero-fluff job-specific cover letter in ${tone} tone with greeting and candidate signature"
}
`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    // O4 — a conservative claim screen, not proof of factual accuracy: it
    // catches a small, enumerable set of unsupported-claim shapes (a gap
    // skill claimed as demonstrated, an unstated metric, an unstated
    // employer). It does NOT verify every sentence is true — the
    // deterministic fallback below is the actual safety mechanism whenever
    // a known violation fires. Never a partial edit of the LLM's text:
    // on failure, the entire generated result is discarded.
    const gapSkills = deriveActionableSkillGaps(profile, opportunity).map((g) => g.skill);
    const supported = isGeneratedKitSupported(
      { coverLetter: parsed.coverLetter, resumeTweaks: parsed.resumeTweaks },
      { gapSkills, rawResumeText: profile.rawResumeText || '', opportunityCompany: opportunity.company },
    );
    if (!supported) {
      console.warn('Gemini Flash output failed the anti-fabrication check, falling back to rule-based generator.');
      return generateFallbackApplicationKit(profile, opportunity, match, tone);
    }

    return {
      resumeTweaks: parsed.resumeTweaks,
      coverLetter: parsed.coverLetter,
      source: 'ai',
    };
  } catch (err) {
    console.warn('Gemini Flash call failed, falling back to rule-based generator:', err);
    return generateFallbackApplicationKit(profile, opportunity, match, tone);
  }
}
