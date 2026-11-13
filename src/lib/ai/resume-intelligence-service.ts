/**
 * Resume Intelligence — server-side orchestration (migration 036, resume PR B).
 * docs/resume-intelligence-design.md §2/§7, approved by Deep 2026-10-17/18.
 *
 * AUDIT FIX (docs/resume-pr-b-audit-2026-10-22.md): the original version of this
 * file called upsert_resume_analysis() with the caller's own session client
 * while the function was GRANTed to service_role only — every write failed
 * with a silent permission-denied error this file never checked, so
 * analysisId was '' for nearly every real analysis, the whole accept/reject
 * UI was dead, and nothing was ever actually cached. Fixed in three parts:
 *   (a) the migration now derives the writer's identity from auth.uid() and
 *       is GRANTed to `authenticated` (see 036's own comment on that function);
 *   (b) every call to upsert_resume_analysis() here now checks its `error`
 *       and only ever reports `analysisId` / `persisted: true` when the row
 *       genuinely exists;
 *   (c) the 'pending' status this function always supported, but that nothing
 *       ever wrote, is now written BEFORE the model is called — turning the
 *       RPC's existing FOR UPDATE row lock into a real, database-level
 *       concurrency guard instead of dead code (Finding C).
 *
 * Pipeline, in order:
 *   1. feature flag check (disabled by default — release boundary)
 *   2. cache lookup (version × mode × job content hash × RESUME_ANALYSIS_VERSION,
 *      status = 'success' only)
 *   3. deterministic pre-pass (always runs; the whole output when AI is
 *      skipped/unavailable); insufficient input returns here, before any
 *      database write — "a request that never got past input validation
 *      costs nothing" (migration 036's own comment)
 *   4. claim a 'pending' row for this exact key. If another request already
 *      holds a live claim, this request stops here — no quota touched, no
 *      model call, no double-count (Finding C)
 *   5. per-user quota (reserve_resume_analysis RPC). If denied, the pending
 *      claim is finalized to 'unavailable' rather than left dangling
 *   6. PII redaction (decision 5: name/email/phone/address/links)
 *   7. OpenAI call — gpt-5-mini, reasoning_effort 'minimal' (locked, see
 *      openai-config.ts), ai_spend_ledger feature key 'resume_intelligence',
 *      under the shared existing cap (decision 4: no separate sub-cap)
 *   8. server validation (evidence-validation.ts) — drops anything
 *      unverifiable before it is stored or returned
 *   9. finalize via upsert_resume_analysis — checked for error; a write
 *      failure here is reported honestly (`persisted: false`) and never
 *      produces a real analysisId, even though the computed analysis content
 *      is still returned so the attempt (and its real OpenAI spend) isn't
 *      wasted on the user's screen
 *
 * NOT yet authorized (decision 6, 2026-10-17/18): live OpenAI calls. Step 7
 * is implemented and unit-testable with an injected client, but
 * RESUME_INTELLIGENCE_ENABLED defaults to false and nothing in this repo's
 * test suite calls OpenAI for real — see test/resume-intelligence-*-suite.ts.
 *
 * WORKSTREAM 1 (2026-10-30, docs/resume-pr-b-workstream1-provider-architecture-plan-
 * 2026-10-30.md): step 7's provider call now goes through providers/registry.ts's
 * AiProviderAdapter/UsageLedger interfaces instead of calling OpenAI's SDK and
 * spend-ledger.ts directly. Behavior-preserving — still always OpenAI today
 * (RESUME_INTELLIGENCE_PROVIDER defaults to 'openai', no other case is wired in) — plus one
 * real addition: a call timeout now exists (previously none did anywhere in src/lib/ai/*.ts).
 *
 * WORKSTREAM 2 (2026-10-30, docs/resume-pr-b-workstream2-pro-entitlement-plan-2026-10-30.md):
 * a new step runs between quota (step 5) and the model call (step 7) — `req.aiAllowed`,
 * established SERVER-SIDE by the caller (the API route, from a fresh `profiles.plan_tier`
 * read, NEVER client-supplied) — decides whether the AI layer is attempted at all. A Free
 * user still gets the full deterministic rules-only floor computed at step 3; this only gates
 * steps 6-9 (PII redaction through finalize-as-AI-sourced). The model is NEVER called for a
 * caller this flag says no to — no reservation, no redaction, no prompt is built.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getResumeIntelligenceProvider, getResumeIntelligenceLedger } from './providers/registry';
import type { ModelCallFailureKind } from './providers/types';
import { recordAiCallEvent, type AiCallOutcome } from '@/lib/observability/ai-events';
import { runDeterministicAnalysis } from '@/lib/resume/rubric';
import { buildAuthenticityReview } from '@/lib/resume/authenticity';
import { redactForModel } from '@/lib/resume/redaction';
import { validateModelOutput, type ValidationContext } from '@/lib/resume/evidence-validation';
import { buildRubricPrompt, RESUME_SYSTEM_PROMPT } from '@/lib/resume/prompt';
import {
  RESUME_ANALYSIS_VERSION,
  type AnalysisMode,
  type AnalysisStatus,
  type RawModelResumeAnalysis,
  type ResumeAnalysis,
} from '@/types/resume-intelligence';

/** Disabled by default (release boundary, design doc §10). An env var so a later, separate,
 *  explicit step can turn it on in a specific environment without a code change. */
export function isResumeIntelligenceEnabled(): boolean {
  return process.env.RESUME_INTELLIGENCE_ENABLED === 'true';
}

// PARTIAL FIX, NOT YET PROVEN SUFFICIENT (browser verification, 2026-11-07): 6000 was too
// small -- a live call against a real multi-bullet resume (7 bullets, 5 sections) consumed 8107
// total tokens and still got cut off before the closing JSON brace, so JSON.parse() threw and
// the user saw a silent 'malformed_response' (ai_unavailable) on an ordinary resume, not just a
// large one. Raised here with real margin above that observed truncation point.
//
// HOWEVER: re-tested live at 16000 with the 90s timeout this file already enforces
// (MODEL_CALL_TIMEOUT_MS) and the call still failed -- this time by running past 90s and being
// aborted, not by truncating. Raising the cap gives the model room to keep generating for
// LONGER, which traded a truncation failure for a timeout failure on the same call; it did not
// make a call succeed. The real bottleneck for this prompt shape/model combination appears to be
// latency (gpt-5-mini taking 80-95+ seconds even at reasoning_effort: 'minimal'), not output
// size. A real fix likely needs a longer timeout AND confirmation the call completes within it --
// NOT separately authorized as part of this change; keeping 16000 here only because it is
// strictly no worse than 6000 (same failure class the user already sees, never a new one), and
// documenting this honestly rather than claiming the underlying defect is resolved.
const MAX_COMPLETION_TOKENS = 16000;
/** Must match the RPC's own window (036_resume_intelligence.sql) — kept as a named constant
 *  here only for the "already in progress" copy; the actual enforcement is entirely in the DB. */
const PENDING_CLAIM_WINDOW_MINUTES = 3;

export interface AnalyzeRequest {
  profileId: string;
  fullName: string | null;
  declaredSkills: string[];
  resumeVersionId: string;
  resumeText: string;
  mode: AnalysisMode;
  opportunityId?: string;
  jobText?: string; // title + description, when mode === 'target_job'
  /** Workstream 2 (docs/resume-pr-b-workstream2-pro-entitlement-plan-2026-10-30.md) — whether
   *  the caller may invoke the AI-powered layer. REQUIRED (no default): every caller must
   *  explicitly decide this, server-side, from a fresh `profiles.plan_tier` read — NEVER from
   *  the request body, NEVER inferred here. `false` still returns the full deterministic
   *  rules-only analysis; it only withholds the AI layer. This is the real, load-bearing gate —
   *  the model is never called when this is false, not even to attempt a reservation. */
  aiAllowed: boolean;
  /** Candidate responses to clarification questions; treated as a separate evidence source. */
  candidateAnswers?: Array<{ questionId: string; question: string; answer: string }>;
}


function buildCandidateAnswerText(answers: AnalyzeRequest['candidateAnswers']): string {
  return (answers ?? [])
    .filter((item) => typeof item?.questionId === 'string' && typeof item?.answer === 'string' && item.answer.trim())
    .slice(0, 8)
    .map((item) => `Answer ${item.questionId}: ${item.answer.trim().slice(0, 1200)}`)
    .join('\n\n');
}

function buildCandidatePromptText(answers: AnalyzeRequest['candidateAnswers']): string {
  return (answers ?? [])
    .filter((item) => typeof item?.questionId === 'string' && typeof item?.question === 'string' && typeof item?.answer === 'string' && item.answer.trim())
    .slice(0, 8)
    .map((item) => `Question: ${item.question.trim().slice(0, 400)}\nCandidate answer: ${item.answer.trim().slice(0, 1200)}`)
    .join('\n\n');
}

export interface AnalyzeResult {
  status: AnalysisStatus;
  /** The resume_analyses row id — the client needs this to record an accept/reject/edit
   *  decision via POST /api/resume/suggestions (record_resume_suggestion_decision). Set ONLY
   *  when `persisted` is true; never a row whose write was not confirmed. */
  analysisId: string;
  /** True only when a database write for THIS analysis was confirmed (no error from
   *  upsert_resume_analysis). False for: the feature disabled, insufficient input, quota
   *  exhausted, another request's claim still in flight, AI unavailable, or — the case this
   *  field exists to make visible — a model call that succeeded but whose save failed. */
  persisted: boolean;
  analysis: ResumeAnalysis;
  cached: boolean;
  quota?: { allowed: boolean; limit: number; remaining: number; planTier: string };
}

/** Maps the provider-agnostic ModelCallFailureKind (providers/types.ts) onto the existing
 *  observability vocabulary (ai-events.ts's AiCallOutcome) — unchanged mapping from the prior
 *  classifyOpenAiError(), just re-expressed against the new, provider-independent kind instead
 *  of inspecting err.status directly (that inspection now lives inside the adapter itself). */
function classifyFailureOutcome(kind: ModelCallFailureKind): AiCallOutcome {
  switch (kind) {
    case 'rate_limited': return 'rate_limited_429';
    case 'model_not_found': return 'model_not_found_404';
    case 'service_unavailable': return 'service_unavailable_503';
    case 'malformed_response': return 'malformed_response';
    default: return 'other';
  }
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyAnalysis(mode: AnalysisMode, status: AnalysisStatus, limitations: ResumeAnalysis['limitations'] = []): ResumeAnalysis {
  return {
    analysisVersion: RESUME_ANALYSIS_VERSION,
    mode,
    analysisStatus: status,
    source: { ai: false, rules: true },
    resumeType: { roleFamily: 'unknown', confidence: 'low', alternatives: [], evidence: [] },
    overallSummary: { text: '', evidence: [] },
    sectionReviews: [],
    strengths: [],
    improvements: [],
    bulletRewrites: [],
    skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
    formattingIssues: [],
    targetJobFit: null,
    keywordAlignment: null,
    actionPlan: [],
    questionsForCandidate: [],
    limitations,
  };
}

/** Builds the "Automated checks" (rules-only) body from the deterministic pass — the fallback
 *  whenever AI is disabled, over quota, or unavailable, and the floor every AI-assisted result
 *  is layered on top of (never replaces). */
function buildRulesOnlyAnalysis(req: AnalyzeRequest, status: AnalysisStatus = 'success'): ResumeAnalysis {
  const det = runDeterministicAnalysis(req.resumeText, req.declaredSkills);
  const authenticityReview = buildAuthenticityReview(req.resumeText, det.bullets);
  if (det.charCount === 0) {
    return emptyAnalysis(req.mode, 'insufficient_input', [{ code: 'empty_input', message: 'No resume text was provided.' }]);
  }

  const formattingIssues: ResumeAnalysis['formattingIssues'] = det.extractionSignals.map((s, i) => ({
    id: `fmt-${i}`,
    text: s.message,
    evidence: [],
    source: 'rules' as const,
  }));

  const chronologyFindings: ResumeAnalysis['sectionReviews'][number]['findings'] = det.chronologyFindings.map((c, i) => ({
    id: `chrono-${i}`,
    text: c.message,
    criterion: 'R8' as const,
    evidence: [],
    source: 'rules' as const,
  }));

  const duplicateFindings: ResumeAnalysis['sectionReviews'][number]['findings'] = det.duplicates.map((d, i) => ({
    id: `dup-${i}`,
    text: `Two bullets look very similar (${d.aId} and ${d.bId}) — consider combining or differentiating them.`,
    criterion: 'R9' as const,
    evidence: [],
    source: 'rules' as const,
  }));

  const demonstrated = det.skillEvidence.filter((s) => s.inExperienceOrProjects).map((s) => ({ skill: s.skill, evidence: [] }));
  const weaklySupported = det.skillEvidence.filter((s) => s.inSkillsOnly).map((s) => ({ skill: s.skill, evidence: [] }));
  const notEvidenced = det.skillEvidence.filter((s) => s.notFound).map((s) => ({ skill: s.skill, note: 'not demonstrated in this resume' as const }));

  const sectionReviews = det.sections.map((sec) => ({
    sectionId: sec.id,
    heading: sec.heading,
    criteria: [],
    findings: [...chronologyFindings.filter(() => sec.id === 'experience' || sec.id.startsWith('experience')), ...duplicateFindings],
    recommendations: [],
  }));

  const limitations: ResumeAnalysis['limitations'] = [];
  if (det.wordCount < 50) {
    limitations.push({ code: 'short_resume', message: 'This resume is quite short — some checks may be less informative.' });
  }

  return {
    ...emptyAnalysis(req.mode, status),
    resumeType: { roleFamily: 'unknown', confidence: 'low', alternatives: [], evidence: [] },
    overallSummary: {
      text: `Automated checks only: ${det.wordCount} words, ${det.sections.length} section(s) recognised, ${det.bullets.length} bullet(s) found.`,
      evidence: [],
    },
    sectionReviews,
    improvements: authenticityReview.findings,
    questionsForCandidate: authenticityReview.questions,
    skillsEvidence: { demonstrated, weaklySupported, notEvidenced },
    formattingIssues,
    limitations,
  };
}

/** Pure merge: AI-sourced fields layer on top of the rules-only base; nothing from the rules
 *  pass is ever replaced by the model, only added to. */
function mergeRulesAndAi(rulesOnly: ResumeAnalysis, aiBody: Awaited<ReturnType<typeof validateModelOutput>>['body'], model: string): ResumeAnalysis {
  return {
    ...rulesOnly,
    source: { ai: true, rules: true, model },
    resumeType: aiBody.resumeType,
    overallSummary: aiBody.overallSummary.text ? aiBody.overallSummary : rulesOnly.overallSummary,
    sectionReviews: aiBody.sectionReviews.length > 0 ? aiBody.sectionReviews : rulesOnly.sectionReviews,
    strengths: aiBody.strengths,
    // Keep deterministic authenticity findings; AI must add value, not replace them.
    improvements: [...rulesOnly.improvements, ...aiBody.improvements]
      .filter((item, index, all) => all.findIndex((other) => other.text.trim().toLowerCase() === item.text.trim().toLowerCase()) === index)
      .slice(0, 12),
    bulletRewrites: aiBody.bulletRewrites,
    skillsEvidence: {
      demonstrated: aiBody.skillsEvidence.demonstrated.length > 0 ? aiBody.skillsEvidence.demonstrated : rulesOnly.skillsEvidence.demonstrated,
      weaklySupported: aiBody.skillsEvidence.weaklySupported.length > 0 ? aiBody.skillsEvidence.weaklySupported : rulesOnly.skillsEvidence.weaklySupported,
      notEvidenced: aiBody.skillsEvidence.notEvidenced.length > 0 ? aiBody.skillsEvidence.notEvidenced : rulesOnly.skillsEvidence.notEvidenced,
    },
    formattingIssues: [...rulesOnly.formattingIssues, ...aiBody.formattingIssues],
    targetJobFit: aiBody.targetJobFit,
    keywordAlignment: aiBody.keywordAlignment,
    actionPlan: aiBody.actionPlan,
    questionsForCandidate: [...rulesOnly.questionsForCandidate, ...aiBody.questionsForCandidate]
      .filter((item, index, all) => all.findIndex((other) => other.question.trim().toLowerCase() === item.question.trim().toLowerCase()) === index)
      .slice(0, 5),
    limitations: [...rulesOnly.limitations, ...aiBody.limitations],
  };
}

/** G1 (decided 2026-10-30): true iff NOTHING the model said survived server validation — every
 *  array/field that could carry an AI-sourced claim is empty/null. `resumeType` is deliberately
 *  EXCLUDED: validateModelOutput() never rejects it wholesale (only its evidence quotes are
 *  filtered), so it would almost always look "non-empty" even when every real claim was dropped,
 *  defeating the point of this check. Used to decide success vs unavailable (G1), never to decide
 *  what to show — the rules-only floor is preserved either way (G1's "preserve rules-based output"
 *  requirement). */
function aiBodyIsEmpty(body: Awaited<ReturnType<typeof validateModelOutput>>['body']): boolean {
  return (
    body.strengths.length === 0 &&
    body.improvements.length === 0 &&
    body.bulletRewrites.length === 0 &&
    body.formattingIssues.length === 0 &&
    body.actionPlan.length === 0 &&
    body.questionsForCandidate.length === 0 &&
    body.keywordAlignment === null &&
    body.overallSummary.text === '' &&
    body.skillsEvidence.demonstrated.length === 0 &&
    body.skillsEvidence.weaklySupported.length === 0 &&
    body.skillsEvidence.notEvidenced.length === 0 &&
    body.sectionReviews.every((sr) => sr.criteria.length === 0 && sr.findings.length === 0 && sr.recommendations.length === 0) &&
    (body.targetJobFit === null || (
      body.targetJobFit.requirements.length === 0 &&
      body.targetJobFit.prioritize.length === 0 &&
      body.targetJobFit.interviewPrep.length === 0 &&
      body.targetJobFit.summaryEdit === undefined &&
      body.targetJobFit.skillsEdit === undefined
    ))
  );
}

/** Calls the configured provider (Workstream 1: resolved via providers/registry.ts — today
 *  always OpenAI) for the AI-assisted pass. Returns null (never throws) on any failure — the
 *  caller falls back to the rules-only result, same fail-safe convention as materials.ts.
 *
 *  Behavior-preserving refactor (docs/resume-pr-b-workstream1-provider-architecture-plan-
 *  2026-10-30.md §4 step 3): same prompt-building, same reservation-before-call,
 *  same consume-not-refund-on-any-response invariant, same observability events. The one real
 *  behavior addition is MODEL_CALL_TIMEOUT_MS, enforced inside the adapter — previously no
 *  timeout existed at all. */
const MODEL_CALL_TIMEOUT_MS = Number(process.env.RESUME_INTELLIGENCE_TIMEOUT_MS) || 120000;

async function callModel(req: AnalyzeRequest, det: ReturnType<typeof runDeterministicAnalysis>): Promise<{ raw: RawModelResumeAnalysis; model: string } | null> {
  return runModelCall(req, det, getResumeIntelligenceProvider(), getResumeIntelligenceLedger());
}

/** The real logic behind callModel(), with the provider/ledger as explicit parameters —
 *  exported ONLY for test use (same rationale as `ModelCaller`/`modelCallerOverride` below):
 *  it lets test/resume-pr-b-workstream1-failure-audit-suite.ts inject a fake AiProviderAdapter/
 *  UsageLedger and assert the real reserve/call/consume/refund sequence for each failure kind,
 *  without a live API key or a real Supabase admin client. Production code never calls this
 *  directly — every real call site goes through callModel(), which always resolves the real
 *  registry. */
export async function runModelCall(
  req: AnalyzeRequest,
  det: ReturnType<typeof runDeterministicAnalysis>,
  provider: ReturnType<typeof getResumeIntelligenceProvider>,
  ledger: ReturnType<typeof getResumeIntelligenceLedger>
): Promise<{ raw: RawModelResumeAnalysis; model: string } | null> {
  const { redactedText } = redactForModel(req.resumeText, req.fullName);
  const candidatePromptText = buildCandidatePromptText(req.candidateAnswers);
  const redactedCandidateText = candidatePromptText ? redactForModel(candidatePromptText, req.fullName).redactedText : '';
  const prompt = buildRubricPrompt({
    mode: req.mode,
    redactedResumeText: redactedText.slice(0, 12000),
    jobText: req.jobText?.slice(0, 4000),
    sections: det.sections,
    bullets: det.bullets,
    redactedCandidateText: redactedCandidateText.slice(0, 6000),
  });

  const reservation = await ledger.reserve('resume_intelligence', {
    kind: 'cost', promptText: prompt, maxCompletionTokens: MAX_COMPLETION_TOKENS,
  });
  if (!reservation.allowed) return null;
  const startedAt = Date.now();

  const outcome = await provider.call({
    systemPrompt: RESUME_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    responseFormat: 'json_object',
    timeoutMs: MODEL_CALL_TIMEOUT_MS,
  });

  if (!outcome.ok) {
    // Same invariant as before this refactor: once the provider was asked at all, consume the
    // reservation, never refund it — the attempt is charged conservatively even on failure.
    const failedConsume = await ledger.consume('resume_intelligence', reservation.reservationToken, { kind: 'cost' });
    await recordAiCallEvent({
      provider: provider.providerId, model: provider.modelId, feature: 'resume_intelligence',
      outcome: classifyFailureOutcome(outcome.failure.kind), latencyMs: Date.now() - startedAt,
      estimatedCostUsd: failedConsume.actualCostUsd,
    });
    return null;
  }

  const { result } = outcome;
  // Capture the reconciled real cost (computed from these same real promptTokens/completionTokens
  // — see openai-ledger.ts/spend-ledger.ts) so both branches below can log it; previously this
  // return value was discarded, so neither the success nor the malformed-response event ever
  // recorded a cost figure despite it being available right here.
  const consumed = await ledger.consume('resume_intelligence', reservation.reservationToken, {
    kind: 'cost', promptTokens: result.promptTokens, completionTokens: result.completionTokens,
  });

  try {
    const parsed = JSON.parse(result.rawContent ?? '') as RawModelResumeAnalysis;
    await recordAiCallEvent({
      provider: provider.providerId, model: result.model, feature: 'resume_intelligence',
      outcome: 'success', latencyMs: Date.now() - startedAt,
      tokensUsed: result.promptTokens + result.completionTokens,
      estimatedCostUsd: consumed.actualCostUsd,
    });
    return { raw: parsed, model: result.model };
  } catch (err) {
    // Same single consumption as above (never a second ledger entry) — this just logs it to
    // observability, same as the success branch. Previously this event recorded neither token
    // nor cost figures at all, despite both already being computed one line above.
    await recordAiCallEvent({
      provider: provider.providerId, model: result.model, feature: 'resume_intelligence',
      outcome: 'malformed_response', latencyMs: Date.now() - startedAt,
      tokensUsed: result.promptTokens + result.completionTokens,
      estimatedCostUsd: consumed.actualCostUsd,
    });
    return null;
  }
}

interface ClaimArgs {
  resumeVersionId: string;
  mode: AnalysisMode;
  opportunityId?: string;
  jobContentHash: string;
  analysisVersion?: string;
}

interface ClaimOutcome {
  /** The row id, present whenever the RPC itself succeeded — regardless of whether THIS call
   *  was the one that wrote (see `wrote`). Null only when the RPC call itself failed. */
  id: string | null;
  /** True only when this specific call's content was the one written (an insert, or an update
   *  that actually changed the row) — false when the RPC no-op'd because a prior success or a
   *  live pending claim from ANOTHER request already occupies this key. */
  wrote: boolean;
  /** The row's attempt_number as of this call (migration 040) — present whenever `id` is.
   *  This is the identifier reserve_resume_analysis/refund_resume_analysis/
   *  finalize_resume_analysis key their per-attempt idempotency/ownership on; callers must
   *  capture it from this claim and pass that SAME value to reserve, any later refund, and the
   *  eventual finalize call for that attempt — never re-read it after finalizing (migration 041
   *  deliberately never advances it there). */
  attemptNumber: number | null;
  /** The Supabase/Postgres error, if the RPC call itself failed (including a permission-denied
   *  error — exactly the class of failure Finding A was silently swallowing). */
  error: { message: string; code?: string } | null;
}

/** The one call site for upsert_resume_analysis (claim/reclaim only, migration 041 — it no
 *  longer accepts a status/result at all, always claims as 'pending') — every caller below MUST
 *  inspect `.error` rather than assume a write happened just because no exception was thrown
 *  (Finding A). */
async function callClaim(supabase: SupabaseClient, a: ClaimArgs): Promise<ClaimOutcome> {
  const { data, error } = await supabase.rpc('upsert_resume_analysis', {
    p_resume_version_id: a.resumeVersionId,
    p_mode: a.mode,
    p_opportunity_id: a.opportunityId ?? null,
    p_job_content_hash: a.jobContentHash,
    p_analysis_version: a.analysisVersion ?? RESUME_ANALYSIS_VERSION,
  });
  if (error) {
    return { id: null, wrote: false, attemptNumber: null, error: { message: error.message, code: (error as { code?: string }).code } };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; wrote?: boolean; attempt_number?: number } | null;
  if (!row?.id) {
    // The RPC returned successfully but with no row — should not happen given the function
    // always RETURNs a row on the success path, but fail closed rather than assume persisted.
    return { id: null, wrote: false, attemptNumber: null, error: { message: 'upsert_resume_analysis returned no row' } };
  }
  return { id: row.id, wrote: row.wrote === true, attemptNumber: row.attempt_number ?? null, error: null };
}

interface FinalizeArgs {
  analysisId: string | null;
  expectedAttemptNumber: number | null;
  status: 'success' | 'unavailable';
  result: Record<string, unknown> | null;
  sourceAi: boolean;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
}

interface FinalizeOutcome {
  /** The row id, present whenever the RPC itself succeeded (including a stale_attempt
   *  rejection, which still returns the row's real id) — null only when the RPC call itself
   *  failed or analysisId/expectedAttemptNumber were missing. */
  id: string | null;
  /** True only when THIS call's content was actually written — false for stale_attempt or
   *  invalid_attempt (see `result` for which). */
  finalized: boolean;
  /** 'finalized' | 'stale_attempt' | 'invalid_attempt' | null (null only when the RPC call
   *  itself errored transport-side, see `.error`). */
  result: string | null;
  error: { message: string; code?: string } | null;
}

/** Migration 041 (Stage 6 follow-up, 2026-11-02, the attempt-ownership fix): the ONLY call site
 *  for finalize_resume_analysis(). Verifies, atomically under the row's own lock, that
 *  `expectedAttemptNumber` is still the row's current attempt_number AND the row is still
 *  `'pending'` before writing anything — a stale worker whose model call finishes long after a
 *  newer attempt has reclaimed the row gets `result: 'stale_attempt'` and writes nothing, rather
 *  than silently overwriting the newer attempt's own result. Never increments attempt_number —
 *  that stays exclusively `upsert_resume_analysis()`'s (claim/reclaim) responsibility. */
async function callFinalize(supabase: SupabaseClient, a: FinalizeArgs): Promise<FinalizeOutcome> {
  if (!a.analysisId || a.expectedAttemptNumber == null) {
    console.warn('[resume-intelligence] callFinalize called with no analysisId/expectedAttemptNumber -- skipping, nothing to finalize');
    return { id: null, finalized: false, result: null, error: { message: 'no analysisId/expectedAttemptNumber' } };
  }
  const { data, error } = await supabase.rpc('finalize_resume_analysis', {
    p_analysis_id: a.analysisId,
    p_expected_attempt_number: a.expectedAttemptNumber,
    p_status: a.status,
    p_result: a.result,
    p_source_ai: a.sourceAi,
    p_model: a.model,
    p_prompt_tokens: a.promptTokens,
    p_completion_tokens: a.completionTokens,
    p_cost_usd: a.costUsd,
  });
  if (error) {
    return { id: null, finalized: false, result: null, error: { message: error.message, code: (error as { code?: string }).code } };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; finalized?: boolean; result?: string } | null;
  if (!row?.id) {
    return { id: null, finalized: false, result: null, error: { message: 'finalize_resume_analysis returned no row' } };
  }
  return { id: row.id, finalized: row.finalized === true, result: row.result ?? null, error: null };
}

/** Stage 6 delivery-review fix (2026-11-02): the finalized specification's own application
 *  contract requires retrying a failed reservation call with the IDENTICAL analysis_id/
 *  attempt_number -- never minting a new attempt just because the RPC response was lost -- and
 *  relying on reserve_resume_analysis()'s own idempotency (a second call with the same
 *  identifiers returns already_reserved, never a double reservation) to make that retry safe.
 *  Mirrors refundQuota() below exactly, including the single retry and the log-only-on-persistent-
 *  failure behavior. */
async function reserveQuota(supabase: SupabaseClient, analysisId: string | null, attemptNumber: number | null): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
  if (!analysisId) {
    console.warn('[resume-intelligence] reserveQuota called with no analysisId -- skipping, nothing to reserve against');
    return { data: null, error: { message: 'no analysisId' } };
  }
  let result = await supabase.rpc('reserve_resume_analysis', { p_analysis_id: analysisId, p_attempt_number: attemptNumber });
  if (result.error) {
    result = await supabase.rpc('reserve_resume_analysis', { p_analysis_id: analysisId, p_attempt_number: attemptNumber });
  }
  if (result.error) {
    console.warn(
      `[resume-intelligence] reserve_resume_analysis failed twice for analysis ${analysisId} attempt ${attemptNumber}:`,
      result.error.message,
    );
  }
  return result;
}

/** Stage 5 independent-review fix (2026-11-02, finding #3 -- HIGH): every prior call site simply
 *  `await`ed refund_resume_analysis() and discarded the result. A timed-out or failed refund was
 *  therefore completely invisible -- unlogged, never retried -- while the analysis still got
 *  finalized as failed, permanently costing the user a quota slot for an attempt that produced no
 *  value. refund_resume_analysis() is idempotent per (analysis_id, attempt_number, 'refunded') --
 *  see migration 040 -- so retrying the IDENTICAL call is always safe and can never double-refund;
 *  one immediate retry closes most of the gap without needing a background job or queue. If it
 *  still fails, this is logged (same `[module] ... (non-fatal, ...)` convention already used by
 *  spend-ledger.ts/quota-ledger.ts/purchase-access.ts) rather than silently swallowed, so the loss
 *  is at least observable instead of invisible. */
async function refundQuota(supabase: SupabaseClient, analysisId: string | null, attemptNumber: number | null, reason: string): Promise<void> {
  if (!analysisId) {
    // Should not happen at either real call site (both run only after the pending claim's own
    // `.error` was already confirmed null, which guarantees a real id) -- fail visibly rather
    // than send a null analysis_id to the RPC.
    console.warn(`[resume-intelligence] refundQuota called with no analysisId (reason: ${reason}) -- skipping, nothing to refund against`);
    return;
  }
  let { error } = await supabase.rpc('refund_resume_analysis', { p_analysis_id: analysisId, p_attempt_number: attemptNumber, p_reason: reason });
  if (error) {
    ({ error } = await supabase.rpc('refund_resume_analysis', { p_analysis_id: analysisId, p_attempt_number: attemptNumber, p_reason: reason }));
  }
  if (error) {
    console.warn(
      `[resume-intelligence] refund_resume_analysis failed twice for analysis ${analysisId} attempt ${attemptNumber} (reason: ${reason}) -- the user's quota reservation was likely NOT returned:`,
      error.message,
    );
  }
}

export type ModelCaller = typeof callModel;

/** The full pipeline. Server-only — never called from client code. `supabase` must be the
 *  caller's own session-scoped client (anon key + the user's JWT/cookie) — RLS and every RPC's
 *  internal auth.uid() check are what keep this scoped to the caller; this function does not
 *  itself re-check auth, but it also never needs or uses a service-role client (Finding A).
 *
 *  `modelCallerOverride` exists ONLY for tests: it lets test/resume-intelligence-persistence-
 *  suite.ts deterministically exercise the "the model call succeeded but the database write
 *  that would have saved it then failed" path (Finding A's post-model case) without a live
 *  OPENAI_API_KEY or a real network call. Production code never passes it — every real call
 *  site (the two API routes) calls analyzeResume(supabase, req) with just two arguments, so the
 *  real callModel() (OpenAI, gated by RESUME_INTELLIGENCE_ENABLED and the spend ledger) is what
 *  always runs outside tests. */
export async function analyzeResume(supabase: SupabaseClient, req: AnalyzeRequest, modelCallerOverride?: ModelCaller): Promise<AnalyzeResult> {
  if (!isResumeIntelligenceEnabled()) {
    return {
      status: 'unavailable', analysisId: '', persisted: false,
      analysis: emptyAnalysis(req.mode, 'unavailable', [{ code: 'feature_disabled', message: 'Resume Intelligence is not yet available.' }]),
      cached: false,
    };
  }

  const jobContentHash = req.mode === 'target_job' && req.jobText ? await sha256Hex(req.jobText) : '';
  const candidateText = buildCandidateAnswerText(req.candidateAnswers);
  const candidatePromptText = buildCandidatePromptText(req.candidateAnswers);
  // Keep every distinct question/answer set in its own cache/claim key. A clarification rerun
  // must never read or overwrite the no-answer analysis (or another answer set).
  const analysisVersion = candidatePromptText
    ? `${RESUME_ANALYSIS_VERSION}-candidate-${(await sha256Hex(candidatePromptText)).slice(0, 16)}`
    : RESUME_ANALYSIS_VERSION;

  // 1. Cache lookup — a confirmed, previously-persisted success only.
  const { data: existing } = await supabase
    .from('resume_analyses')
    .select('id, status, result, source_ai')
    .eq('profile_id', req.profileId)
    .eq('resume_version_id', req.resumeVersionId)
    .eq('mode', req.mode)
    .eq('job_content_hash', jobContentHash)
    .eq('analysis_version', analysisVersion)
    .eq('status', 'success')
    .maybeSingle();
  if (existing?.result) {
    return { status: 'success', analysisId: existing.id as string, persisted: true, analysis: existing.result as unknown as ResumeAnalysis, cached: true };
  }

  // 2. Deterministic pass — always runs, always the floor. Input too thin to say anything
  // costs nothing: no pending claim, no quota, no database write at all.
  const det = runDeterministicAnalysis(req.resumeText, req.declaredSkills);
  if (det.charCount === 0 || req.resumeText.trim().length < 1) {
    const analysis = buildRulesOnlyAnalysis(req, 'insufficient_input');
    return { status: analysis.analysisStatus, analysisId: '', persisted: false, analysis, cached: false };
  }
  const rulesOnly = buildRulesOnlyAnalysis(req);
  const upsertBase = { resumeVersionId: req.resumeVersionId, mode: req.mode, opportunityId: req.opportunityId, jobContentHash, analysisVersion };

  // 3. Claim 'pending' — the real, database-level concurrency guard (Finding C). If another
  // request already holds a live claim for this EXACT key, stop here: no quota reserved, no
  // model called, no double-count from a double-click or a second open tab.
  const claim = await callClaim(supabase, upsertBase);
  if (claim.error) {
    const analysis: ResumeAnalysis = { ...rulesOnly, limitations: [...rulesOnly.limitations, { code: 'not_saved', message: 'Could not start this analysis right now. Please try again.' }] };
    return { status: 'unavailable', analysisId: '', persisted: false, analysis, cached: false };
  }
  if (!claim.wrote) {
    const analysis: ResumeAnalysis = {
      ...rulesOnly,
      limitations: [...rulesOnly.limitations, { code: 'already_in_progress', message: `An analysis for this is already running (started within the last ${PENDING_CLAIM_WINDOW_MINUTES} minutes) — please wait a moment and try again.` }],
    };
    return { status: 'unavailable', analysisId: '', persisted: false, analysis, cached: false };
  }

  // 4. Quota — reserved only once this request genuinely owns the attempt. attemptNumber is
  // captured from the step-3 claim above and reused for the refund below (steps 5/6) — the row's
  // attempt_number keeps advancing on every later write to this row (e.g. the terminal-status
  // finalize calls below), so this one value is deliberately captured once per request and never
  // re-read, keeping the reserve/refund pair scoped to this exact attempt (migration 040).
  const attemptNumber = claim.attemptNumber;
  const { data: quota, error: quotaError } = await reserveQuota(supabase, claim.id, attemptNumber);
  const quotaResult = quota as { result: string; allowed: boolean; limit: number; remaining: number; planTier: string } | null;
  if (quotaError || !quotaResult?.allowed) {
    // Finalize the pending claim we just took rather than leaving it dangling for 3 minutes.
    await callFinalize(supabase, { analysisId: claim.id, expectedAttemptNumber: attemptNumber, status: 'unavailable', result: null, sourceAi: false, model: null, promptTokens: null, completionTokens: null, costUsd: null });
    // Stage 5 independent-review fix (2026-11-02, finding #2 -- MEDIUM): a transport/RPC error
    // was previously indistinguishable from a genuine limit_reached response -- both silently
    // fell into the same quota_exhausted branch below, so a dropped connection showed the user
    // "you've used all your analyses today," which is simply false. Distinguished explicitly now.
    const limitation = quotaError
      ? { code: 'reservation_failed', message: 'Could not check your resume-analysis quota right now. Please try again in a moment. Automated checks are still shown below.' }
      : { code: 'quota_exhausted', message: 'You have used all of today\'s resume analyses. Automated checks are still shown below.' };
    const analysis: ResumeAnalysis = { ...rulesOnly, limitations: [...rulesOnly.limitations, limitation] };
    return { status: 'success', analysisId: '', persisted: false, analysis, cached: false, quota: quotaResult ?? undefined };
  }

  // 5. Entitlement (Workstream 2) — decided by the caller, server-side, before this function
  // was ever invoked; never re-derived here from anything client-suppliable. A Free user still
  // keeps the rules-only floor built above; only the AI layer (steps 6-9) is withheld. Same
  // refund/finalize shape as every other "stop before reaching the model" branch in this
  // function — reservation.ts's own convention ("a call that fails before reaching the model
  // is given back") applies here exactly: entitlement denial IS such a failure.
  if (!req.aiAllowed) {
    await refundQuota(supabase, claim.id, attemptNumber, 'upgrade_required');
    const finalized = await callFinalize(supabase, { analysisId: claim.id, expectedAttemptNumber: attemptNumber, status: 'unavailable', result: null, sourceAi: false, model: null, promptTokens: null, completionTokens: null, costUsd: null });
    const analysis: ResumeAnalysis = { ...rulesOnly, limitations: [...rulesOnly.limitations, { code: 'upgrade_required', message: 'AI-powered analysis is a Pro feature. Automated checks are still shown below.' }] };
    return { status: 'unavailable', analysisId: finalized.id ?? '', persisted: finalized.result === 'finalized', analysis, cached: false, quota: quotaResult };
  }

  // 6. Model call.
  const modelResult = await (modelCallerOverride ?? callModel)(req, det);
  if (!modelResult) {
    // Spend refund rule unchanged (OpenAI was never reached, or reservation itself was denied):
    // refund the per-user analysis quota the same way. The pending row is finalized either way.
    await refundQuota(supabase, claim.id, attemptNumber, 'ai_unavailable');
    const finalized = await callFinalize(supabase, { analysisId: claim.id, expectedAttemptNumber: attemptNumber, status: 'unavailable', result: null, sourceAi: false, model: null, promptTokens: null, completionTokens: null, costUsd: null });
    const analysis: ResumeAnalysis = { ...rulesOnly, limitations: [...rulesOnly.limitations, { code: 'ai_unavailable', message: 'AI analysis is temporarily unavailable. Automated checks are still shown below.' }] };
    return { status: 'unavailable', analysisId: finalized.id ?? '', persisted: finalized.result === 'finalized', analysis, cached: false, quota: quotaResult };
  }

  // 7. Validate.
  const ctx: ValidationContext = {
    resumeText: req.resumeText,
    redactedResumeText: redactForModel(req.resumeText, req.fullName).redactedText,
    redactionSpans: redactForModel(req.resumeText, req.fullName).spans,
    jobText: req.jobText ?? '',
    candidateText,
    redactedCandidateText: candidateText ? redactForModel(candidateText, req.fullName).redactedText : '',
    candidateRedactionSpans: candidateText ? redactForModel(candidateText, req.fullName).spans : [],
    // G2 (decided 2026-10-30): the server's OWN known-correct identifiers, never the model's
    // echoed values — req.opportunityId is what the caller actually requested, and jobContentHash
    // is computed above (step 0) from the server's own req.jobText, before the model ever saw it.
    opportunityId: req.opportunityId,
    jobContentHash,
  };
  const { body } = validateModelOutput(modelResult.raw, ctx, req.declaredSkills);

  // G1 (decided 2026-10-30): a rules-only result is never reported as a successful AI analysis.
  // `success` means at least one AI-sourced item survived validation; `unavailable` means none
  // did, and only the deterministic floor remains — still preserved, never discarded.
  const aiSurvived = !aiBodyIsEmpty(body);
  const finalStatus: AnalysisStatus = aiSurvived ? 'success' : 'unavailable';
  const merged: ResumeAnalysis = aiSurvived
    ? mergeRulesAndAi(rulesOnly, body, modelResult.model)
    : {
        ...rulesOnly,
        analysisStatus: 'unavailable',
        limitations: [
          ...rulesOnly.limitations,
          ...body.limitations,
          { code: 'ai_unverifiable', message: 'The AI analysis could not be verified against your resume, so only automated checks are shown below.' },
        ],
      };

  // 8. Finalize — ownership-aware (migration 041, Stage 6 follow-up fix). A real, billable
  // OpenAI call already happened, so quota is NOT refunded here even if the save fails or this
  // attempt turns out to be stale: the attempt genuinely occurred and the design's own quota
  // semantics ("count only attempts that actually reach the model") must reflect that, not
  // quietly give the user an extra free try because of a database hiccup or a slow worker.
  const finalStored = await callFinalize(supabase, {
    analysisId: claim.id, expectedAttemptNumber: attemptNumber, status: finalStatus,
    result: merged as unknown as Record<string, unknown>,
    sourceAi: aiSurvived, model: modelResult.model, promptTokens: null, completionTokens: null, costUsd: null,
  });
  if (finalStored.error) {
    const analysis: ResumeAnalysis = { ...merged, limitations: [...merged.limitations, { code: 'not_saved', message: 'This analysis could not be saved. Accept, edit and reject are unavailable until you retry.' }] };
    return { status: finalStatus, analysisId: '', persisted: false, analysis, cached: false, quota: quotaResult };
  }
  if (finalStored.result === 'stale_attempt') {
    // This exact race Stage 6 identified: a model call that finishes long after a newer attempt
    // has reclaimed this row. The row's real, current content belongs to that newer attempt, not
    // this one -- writing nothing here (migration 041's whole point) is correct; the content
    // computed in THIS request is simply discarded, not persisted and not reported as if it were.
    const analysis: ResumeAnalysis = { ...merged, limitations: [...merged.limitations, { code: 'superseded', message: 'A more recent analysis attempt has already completed for this resume. Please refresh to see the latest result.' }] };
    return { status: finalStatus, analysisId: finalStored.id ?? '', persisted: false, analysis, cached: false, quota: quotaResult };
  }

  return { status: finalStatus, analysisId: finalStored.id ?? '', persisted: true, analysis: merged, cached: false, quota: quotaResult };
}
