// AI Phase 1B provider switch (docs/ai-phase1b-implementation-plan.md,
// locked §7.2: switch all three files now). Was Gemini; is now OpenAI
// (`gpt-5-mini` via openai-config.ts). This file's real-AI path is STILL
// structurally unreachable in production (ticket O1/O5's separate,
// already-identified client/server finding: called from onboarding
// client-side, where any `*_API_KEY` env var is always undefined in the
// browser) — independent of which provider is configured here. That issue
// stays exactly as HELD — NOT resolved by this change, which is a
// mechanical provider swap only, same as the earlier Gemini-model-id
// cleanup this file already went through
// (docs/gemini-compatibility-remediation-spec.md §5).
import { getOpenAiClient, OPENAI_MODEL_ID, OPENAI_REASONING_EFFORT } from './openai-config';
import { reserveOpenAiSpend, consumeOpenAiSpend } from './spend-ledger';
import { recordAiCallEvent, type AiCallOutcome } from '@/lib/observability/ai-events';
import { PersonProfile, ProfileExperience, ProfileSkill } from '@/types/byn';

function classifyOpenAiError(err: unknown): AiCallOutcome {
  const status = (err as { status?: number })?.status;
  if (status === 429) return 'rate_limited_429';
  if (status === 404) return 'model_not_found_404';
  if (status && status >= 500) return 'service_unavailable_503';
  return 'other';
}

export interface ExtractedResumeData {
  fullName: string;
  headline: string;
  targetRoles: string[];
  skills: string[];
  yearsOfExperience: '0-1' | '2-3' | '4-6' | '7-10' | '10+';
  currentCountry: string;
  currentTimezone: string;
  experiences: Array<{
    company: string;
    roleTitle: string;
    startDate?: string;
    endDate?: string;
    isCurrent: boolean;
    achievements: string[];
  }>;
  summary: string;
}

// Fallback regex & heuristic parser when API key is not present
export function parseResumeHeuristically(rawText: string): ExtractedResumeData {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const fullName = lines[0] || 'Alex Candidate';

  // Common tech skills detection
  const commonTech = [
    'React', 'Next.js', 'TypeScript', 'JavaScript', 'Node.js', 'Python', 'Go', 'Golang',
    'PostgreSQL', 'SQL', 'MongoDB', 'AWS', 'Docker', 'Kubernetes', 'GraphQL', 'Tailwind CSS',
    'Figma', 'Product Management', 'Git', 'CI/CD', 'FastAPI', 'Django', 'Rust', 'Ruby'
  ];

  const foundSkills = commonTech.filter((skill) =>
    new RegExp(`\\b${skill.replace('.', '\\.')}\\b`, 'i').test(rawText)
  );

  return {
    fullName,
    headline: 'Full Stack & Remote Software Engineer',
    targetRoles: ['Full Stack Engineer', 'Frontend Engineer', 'Software Engineer'],
    skills: foundSkills.length > 0 ? foundSkills : ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
    yearsOfExperience: '4-6',
    currentCountry: 'Worldwide',
    currentTimezone: 'UTC',
    experiences: [
      {
        company: 'Distributed Tech Inc.',
        roleTitle: 'Senior Software Engineer',
        startDate: '2021',
        endDate: 'Present',
        isCurrent: true,
        achievements: [
          'Architected high-throughput web applications with Next.js and TypeScript.',
          'Collaborated with global async engineering teams across 6 time zones.',
        ],
      },
    ],
    summary: rawText.slice(0, 300) || 'Experienced remote professional with a track record of scalable software delivery.',
  };
}

// Full AI parser (OpenAI gpt-5-mini) — renamed from parseResumeWithGemini
// (AI Phase 1B provider switch) to stay provider-neutral, matching
// analyzeResumeWithAI's already-established naming in resume-intelligence.ts.
export async function parseResumeWithAI(rawText: string): Promise<ExtractedResumeData> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return parseResumeHeuristically(rawText);
  }

  const MAX_COMPLETION_TOKENS = 1500;

  const prompt = `
Extract structured candidate profile information from this resume or professional profile text.

Resume Text:
"""
${rawText.slice(0, 4000)}
"""

Output ONLY valid JSON matching this exact structure:
{
  "fullName": "Name",
  "headline": "Brief professional headline",
  "targetRoles": ["Role 1", "Role 2"],
  "skills": ["Skill 1", "Skill 2", "Skill 3"],
  "yearsOfExperience": "4-6", // Must be one of: "0-1", "2-3", "4-6", "7-10", "10+"
  "currentCountry": "Country or Worldwide",
  "currentTimezone": "UTC, EST, CET, IST, etc.",
  "experiences": [
    {
      "company": "Company Name",
      "roleTitle": "Role Title",
      "startDate": "2021",
      "endDate": "Present",
      "isCurrent": true,
      "achievements": ["Achievement bullet 1", "Achievement bullet 2"]
    }
  ],
  "summary": "2-3 sentence executive summary"
}
`;

  const reservation = await reserveOpenAiSpend('resume_parsing', prompt, MAX_COMPLETION_TOKENS);
  if (!reservation.allowed) {
    return parseResumeHeuristically(rawText);
  }
  const { usagePeriod, reservedCostUsd } = reservation as { usagePeriod: string; reservedCostUsd: number };
  const startedAt = Date.now();

  // Two explicit stages, same shape as career-page-extraction.ts's Phase 1A
  // pattern: the reservation is consumed exactly once, right after the API
  // call itself resolves (success OR failure) — never again afterward, even
  // if a post-success JSON.parse subsequently fails.
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
    // Reached OpenAI (an HTTP error status) or a genuine network failure —
    // either way, consume rather than refund: safer to under-report
    // available spend than to risk believing budget exists once a request
    // already left the process.
    const failedConsume = await consumeOpenAiSpend('resume_parsing', usagePeriod, reservedCostUsd);
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_parsing',
      outcome: classifyOpenAiError(err), latencyMs: Date.now() - startedAt,
      estimatedCostUsd: failedConsume.actualCostUsd,
    });
    console.warn('OpenAI resume parsing failed, using fallback:', err);
    return parseResumeHeuristically(rawText);
  }

  const usage = completion.usage;
  // Use the RECONCILED actual cost, never reservedCostUsd — see
  // OpenAiConsumeResult's doc comment in spend-ledger.ts.
  const { actualCostUsd, tokensUsed } = await consumeOpenAiSpend(
    'resume_parsing', usagePeriod, reservedCostUsd, usage?.prompt_tokens, usage?.completion_tokens
  );

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '');
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_parsing',
      outcome: 'success', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    return parsed;
  } catch (err) {
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: 'resume_parsing',
      outcome: 'malformed_response', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    console.warn('OpenAI resume parsing returned unparseable JSON, using fallback:', err);
    return parseResumeHeuristically(rawText);
  }
}
