import { getOpenAiClient, OPENAI_MODEL_ID, OPENAI_REASONING_EFFORT } from './openai-config';
import { reserveOpenAiSpend, consumeOpenAiSpend } from './spend-ledger';
import { recordAiCallEvent, type AiCallOutcome } from '@/lib/observability/ai-events';
import { CanonicalOpportunity, PersonProfile, MatchAnalysisResult } from '@/types/byn';

/**
 * LinkedIn Job Finder — connection-message draft generator (plan §22 step
 * [4], §28 point 3). Modeled directly on generateApplicationKit()
 * (src/lib/ai/materials.ts): same provider (OpenAI, gpt-5-mini, mandatory
 * reasoning_effort), same reserve-before-call / consume-after-response
 * spend-ledger discipline, same deterministic-template fallback when no
 * key is configured or the reservation is denied. Uses the ALREADY-
 * AUTHORIZED OPENAI_API_KEY (the same one O3/O4 already use in production)
 * — this file provisions no new vendor account or key.
 *
 * Deliberately recipient-agnostic: the draft never claims to know who it's
 * addressed to (no fabricated name/title) — plan §28's people-search step
 * has no compliant way to identify a real person, so the user always picks
 * someone on LinkedIn themselves and personalizes the draft before sending
 * it (plan §29 step 6 — RemoteMatch never touches the actual send).
 */

function classifyOpenAiError(err: unknown): AiCallOutcome {
  const status = (err as { status?: number })?.status;
  if (status === 429) return 'rate_limited_429';
  if (status === 404) return 'model_not_found_404';
  if (status && status >= 500) return 'service_unavailable_503';
  return 'other';
}

export type ConnectionMessageSource = 'ai' | 'template';

export interface ConnectionMessageDraft {
  message: string;
  source: ConnectionMessageSource;
}

const AI_FEATURE_NAME = 'linkedin_connection_message';
const MAX_COMPLETION_TOKENS = 400;

function generateFallbackDraft(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity,
  match: MatchAnalysisResult
): ConnectionMessageDraft {
  const name = profile.fullName || 'a candidate';
  const topStrength = match.strengths[0] || `experience relevant to ${opportunity.title}`;
  const message = `Hi — I'm ${name}, and I came across the ${opportunity.title} role at ${opportunity.company}. ${topStrength}, and I'd love to connect and learn more about the team. Open to a quick chat if you have a few minutes!`;
  return { message, source: 'template' };
}

export async function generateConnectionMessageDraft(
  profile: PersonProfile,
  opportunity: CanonicalOpportunity,
  match: MatchAnalysisResult
): Promise<ConnectionMessageDraft> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return generateFallbackDraft(profile, opportunity, match);
  }

  const prompt = `
You are helping a job seeker draft a short, genuine LinkedIn connection-request note. It must be recipient-agnostic (the seeker has not chosen a specific person yet) and under 300 characters, matching LinkedIn's own connection-note length limit.

CRITICAL INVARIANT: do not invent metrics, employers, or credentials not present below.

Candidate: ${profile.fullName}
Top strengths for this role: ${match.strengths.slice(0, 2).join('; ') || 'relevant remote work experience'}

Opportunity: ${opportunity.title} at ${opportunity.company}

Output ONLY valid JSON: {"message": "the connection note text"}
`;

  const reservation = await reserveOpenAiSpend(AI_FEATURE_NAME, prompt, MAX_COMPLETION_TOKENS);
  if (!reservation.allowed) {
    return generateFallbackDraft(profile, opportunity, match);
  }
  const { usagePeriod, reservedCostUsd } = reservation as { usagePeriod: string; reservedCostUsd: number };
  const startedAt = Date.now();

  let completion;
  try {
    const client = getOpenAiClient();
    completion = await client.chat.completions.create({
      model: OPENAI_MODEL_ID,
      reasoning_effort: OPENAI_REASONING_EFFORT,
      response_format: { type: 'json_object' },
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    const failedConsume = await consumeOpenAiSpend(AI_FEATURE_NAME, usagePeriod, reservedCostUsd);
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: AI_FEATURE_NAME,
      outcome: classifyOpenAiError(err), latencyMs: Date.now() - startedAt,
      estimatedCostUsd: failedConsume.actualCostUsd,
    });
    console.warn('OpenAI connection-message call failed, falling back to template:', err);
    return generateFallbackDraft(profile, opportunity, match);
  }

  const usage = completion.usage;
  const { actualCostUsd, tokensUsed } = await consumeOpenAiSpend(
    AI_FEATURE_NAME, usagePeriod, reservedCostUsd,
    usage?.prompt_tokens, usage?.completion_tokens
  );

  try {
    const responseText = completion.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(responseText);
    if (typeof parsed.message !== 'string' || parsed.message.trim().length === 0) {
      throw new Error('empty message field');
    }
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: AI_FEATURE_NAME,
      outcome: 'success', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    return { message: parsed.message.trim(), source: 'ai' };
  } catch (err) {
    await recordAiCallEvent({
      provider: 'openai', model: OPENAI_MODEL_ID, feature: AI_FEATURE_NAME,
      outcome: 'malformed_response', latencyMs: Date.now() - startedAt,
      tokensUsed, estimatedCostUsd: actualCostUsd,
    });
    console.warn('OpenAI connection-message response was unparseable, falling back to template:', err);
    return generateFallbackDraft(profile, opportunity, match);
  }
}
