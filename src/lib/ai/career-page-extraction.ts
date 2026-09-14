import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModel, GEMINI_MODEL_ID } from './gemini-config';
import { reserveGeminiRequest, consumeGeminiRequest, refundGeminiReservation } from './quota-ledger';
import { getCachedExtraction, setCachedExtraction } from './gemini-cache';
import { recordAiCallEvent, type AiCallOutcome } from '@/lib/observability/ai-events';
import { createContentHash } from '@/lib/ingestion/pipeline';

/**
 * Supply Discovery gate C5 — Gemini career-page extraction (docs/c5-implementation-plan.md §5)
 * ==============================================================================
 * Explicitly does NOT follow resume.ts's pattern of falling back to a
 * heuristic/fabricated result when Gemini is unavailable or fails. That
 * pattern is correct for resume.ts's own use case (worst case: a slightly
 * generic profile-onboarding prefill the user immediately sees and edits)
 * but wrong here: a fabricated job value shown to a real user as a real
 * job is exactly the "unverifiable job entering the feed" failure mode
 * this whole gate exists to prevent. This module returns null on any
 * failure — never a guessed value.
 *
 * Models `anti-fabrication.ts`'s discipline instead: every semantic field
 * this returns is paired with an `*Evidence` string that
 * `validateExtraction()` (src/lib/ingestion/extraction-validation.ts) must
 * confirm is an actual substring of the source text before the field is
 * trusted. This module only asks Gemini to produce evidence-tagged output;
 * it does not itself decide anything is true — that's extraction-validation's
 * job, exactly mirroring how `isGeneratedKitSupported()` — not the LLM
 * call — is the actual trust boundary in ticket O4.
 *
 * `officialUrl` is intentionally NOT evidence-checked: it comes from the
 * page's own apply-link/canonical URL (passed in, not extracted from free
 * text), so there is no fabrication vector to validate against.
 *
 * Company name is never part of this schema. It always comes from
 * `allowlist_employers.canonical_name` (the same trusted-registry pattern
 * C3's ATS adapters already use) — eliminating employer-name fabrication
 * by construction, not by a post-hoc check.
 */

export interface CareerPageExtraction {
  title: string;
  titleEvidence: string;
  description: string;
  locationString: string;
  locationEvidence: string;
  publicationDate: string | null;
  publicationDateEvidence: string | null;
  salaryMin?: number;
  salaryMax?: number;
  salaryEvidence?: string;
  jobType: string;
  jobTypeEvidence: string;
  officialUrl: string;
}

const EXTRACTION_PROMPT_TEMPLATE = (sourceText: string) => `
You are extracting structured data from the text of a SINGLE job posting on a
company's own career page. This text has already been isolated to one
posting — do not look for or invent any other posting.

For every field below, you must also provide the EXACT verbatim substring
from the source text that supports it ("evidence"). The evidence string must
be copied character-for-character from the source text — do not paraphrase,
summarize, or reformat it. If you cannot find a real supporting substring for
a field, you MUST leave that field's value empty/null rather than guessing —
a wrong or invented value is far worse than a missing one.

Never invent a date. If no explicit publication/posting date appears in the
text, set both "publicationDate" and "publicationDateEvidence" to null — do
not infer a date from context, and do not use today's date.

Do NOT include the company name anywhere in your output — it is not needed
and must not be guessed from the text.

Source Text:
"""
${sourceText}
"""

Output ONLY valid JSON matching this exact structure:
{
  "title": "Job title as stated",
  "titleEvidence": "exact substring from source text",
  "description": "A concise 1-3 sentence summary of the role, drawn only from the source text",
  "locationString": "Location or remote-eligibility text as stated",
  "locationEvidence": "exact substring from source text",
  "publicationDate": "ISO 8601 date string, or null if not explicitly stated",
  "publicationDateEvidence": "exact substring from source text, or null",
  "salaryMin": null,
  "salaryMax": null,
  "salaryEvidence": null,
  "jobType": "Full-time, Part-time, Contract, etc., as stated or reasonably implied by the posting's own wording",
  "jobTypeEvidence": "exact substring from source text"
}
`;

/** Classifies a caught Gemini SDK error into the small closed vocabulary
 *  ai_call_events.outcome accepts (migration 022) — string-matches the
 *  SDK's own error message shape (`[GoogleGenerativeAI Error]: Error
 *  fetching from ...: [429/503/404 ...]`), the same shape real verification
 *  this project has already observed live (Phase 0/0b). Best-effort only —
 *  falls to 'other' for anything unrecognized, which is fine since this
 *  classification is for observability, not for the reserve/consume/refund
 *  safety invariant (that invariant does not depend on knowing WHICH
 *  failure occurred, only THAT the provider was reached at all). */
function classifyGeminiError(err: unknown): AiCallOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (/\[429/.test(message)) return 'quota_exceeded_429';
  if (/\[503/.test(message)) return 'service_unavailable_503';
  if (/\[404/.test(message)) return 'model_not_found_404';
  return 'other';
}

/**
 * Calls Gemini once for one already-isolated job-posting text block.
 * Returns null on ANY failure (missing API key, network error, malformed
 * response, missing required fields, budget exhaustion) — never a
 * fallback/heuristic guess. The caller (career-page.ts) is expected to
 * skip this candidate entirely when null is returned, exactly as it does
 * for any other extraction failure — a budget exhaustion is deliberately
 * indistinguishable from any other failure to every downstream caller.
 *
 * AI Phase 1A (docs/ai-phase1-implementation-plan.md §5) wraps this call
 * with, in order: a content-hash cache lookup (skips Gemini entirely on a
 * hit — evidence validation still re-runs downstream against the CURRENT
 * source text regardless, this function's return contract is unchanged
 * either way), a per-employer soft-cap check + a global request-count
 * reservation (skips the call entirely if either denies it), and — after
 * the call — a consume (never refund) of that reservation for ANY response
 * Gemini actually returns, success or failure alike. The one safety
 * invariant that must never be violated by a future edit here: once
 * `model.generateContent()` has been awaited (meaning the HTTP request
 * left this process), every exit path from that point on must call
 * `consumeGeminiRequest()`, never `refundGeminiReservation()` — refund is
 * reserved for a reservation that's abandoned BEFORE the network call is
 * even attempted, which does not happen in this function's current shape
 * (nothing between a successful reservation and the `generateContent()`
 * call performs any I/O that could fail) but is structured explicitly in
 * case a future pre-flight step is ever inserted here.
 */
export async function extractJobFromCareerPageText(
  sourceText: string,
  officialUrl: string,
  employerId: string
): Promise<CareerPageExtraction | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const truncatedText = sourceText.slice(0, 4000);
  const contentHash = createContentHash(truncatedText);

  const cached = await getCachedExtraction(contentHash);
  if (cached) {
    await recordAiCallEvent({
      provider: 'gemini', model: GEMINI_MODEL_ID, feature: 'c5_extraction',
      outcome: 'success', cacheHit: true,
    });
    return { ...cached, officialUrl };
  }

  const reservation = await reserveGeminiRequest(employerId);
  if (!reservation.allowed) return null; // budget exhausted (global or per-employer) — nothing was reserved, nothing to refund
  const usageDate = reservation.usageDate!;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = getGeminiModel(genAI);
  const startedAt = Date.now();

  let result;
  try {
    result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: EXTRACTION_PROMPT_TEMPLATE(truncatedText) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
  } catch (err) {
    // Reached Gemini's endpoint (an HTTP error status) or a genuine network
    // failure — either way, per the plan's conservative safety rule, this
    // consumes the reservation rather than refunding it: it's safer to
    // slightly under-report available budget than to risk believing
    // capacity exists when a request already left the process.
    await consumeGeminiRequest(employerId, usageDate);
    await recordAiCallEvent({
      provider: 'gemini', model: GEMINI_MODEL_ID, feature: 'c5_extraction',
      outcome: classifyGeminiError(err), cacheHit: false, latencyMs: Date.now() - startedAt,
    });
    console.error('[career-page-extraction] Gemini extraction failed:', err);
    return null;
  }

  await consumeGeminiRequest(employerId, usageDate);
  const latencyMs = Date.now() - startedAt;

  try {
    const parsed = JSON.parse(result.response.text());

    // Minimal shape guard only — this is NOT the evidence-substring check
    // (that is extraction-validation.ts's job, run against the real
    // untruncated source text). This just rejects a response too malformed
    // to even attempt validation against.
    if (
      typeof parsed.title !== 'string' || !parsed.title ||
      typeof parsed.titleEvidence !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.locationString !== 'string' ||
      typeof parsed.locationEvidence !== 'string' ||
      typeof parsed.jobType !== 'string' ||
      typeof parsed.jobTypeEvidence !== 'string'
    ) {
      await recordAiCallEvent({
        provider: 'gemini', model: GEMINI_MODEL_ID, feature: 'c5_extraction',
        outcome: 'malformed_response', cacheHit: false, latencyMs,
        tokensUsed: result.response.usageMetadata?.totalTokenCount,
      });
      return null;
    }

    const extraction: CareerPageExtraction = {
      title: parsed.title,
      titleEvidence: parsed.titleEvidence,
      description: parsed.description,
      locationString: parsed.locationString,
      locationEvidence: parsed.locationEvidence,
      publicationDate: typeof parsed.publicationDate === 'string' ? parsed.publicationDate : null,
      publicationDateEvidence: typeof parsed.publicationDateEvidence === 'string' ? parsed.publicationDateEvidence : null,
      salaryMin: typeof parsed.salaryMin === 'number' ? parsed.salaryMin : undefined,
      salaryMax: typeof parsed.salaryMax === 'number' ? parsed.salaryMax : undefined,
      salaryEvidence: typeof parsed.salaryEvidence === 'string' ? parsed.salaryEvidence : undefined,
      jobType: parsed.jobType,
      jobTypeEvidence: parsed.jobTypeEvidence,
      officialUrl,
    };

    await setCachedExtraction(contentHash, extraction);
    await recordAiCallEvent({
      provider: 'gemini', model: GEMINI_MODEL_ID, feature: 'c5_extraction',
      outcome: 'success', cacheHit: false, latencyMs,
      tokensUsed: result.response.usageMetadata?.totalTokenCount,
    });

    return extraction;
  } catch (err) {
    // JSON.parse or another post-response failure — Gemini was already
    // reached (consumeGeminiRequest() already ran above), this is purely
    // about what we do with an already-consumed call's response.
    await recordAiCallEvent({
      provider: 'gemini', model: GEMINI_MODEL_ID, feature: 'c5_extraction',
      outcome: 'malformed_response', cacheHit: false, latencyMs,
    });
    console.error('[career-page-extraction] Gemini extraction failed:', err);
    return null;
  }
}
