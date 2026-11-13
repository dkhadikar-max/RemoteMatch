/**
 * Resume Intelligence — the client-side logic behind one accept/reject/edit
 * decision, extracted out of src/app/resume-intelligence/page.tsx so it can
 * be unit-tested with an injected `fetch` (audit fix, Finding B, docs/
 * resume-pr-b-audit-2026-10-22.md). The UI must only ever show a decision
 * as confirmed once this returns `ok: true` — never optimistically.
 */

export type SuggestionDecision = 'accepted' | 'rejected' | 'edited';

export interface DecisionOutcome {
  ok: boolean;
  /** Echoed back only on success, so the caller can set its confirmed-decision state from the
   *  same value it sent, without having to remember it separately. */
  decision?: SuggestionDecision;
  /** A user-facing message, set only when `ok` is false. */
  errorMessage?: string;
  /** True when the server's reason was "this analysis isn't yours" (HTTP 403) — the caller can
   *  use this to decide whether retrying makes sense (it never will for a 403). */
  forbidden?: boolean;
}

/**
 * POSTs one decision to /api/resume/suggestions and reports the outcome truthfully — never
 * assumes success just because the request didn't throw. A non-2xx response, including a 403
 * for an analysis that belongs to someone else, is reported as `ok: false` with a message that
 * never echoes back anything about the analysis's own content (the route itself already keeps
 * its 403 body to one generic line; this function doesn't add anything beyond that).
 */
export async function submitSuggestionDecision(
  fetchImpl: typeof fetch,
  analysisId: string,
  suggestionId: string,
  decision: SuggestionDecision,
  finalText?: string
): Promise<DecisionOutcome> {
  let res: Response;
  try {
    res = await fetchImpl('/api/resume/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisId, suggestionId, decision, finalText }),
    });
  } catch {
    return { ok: false, errorMessage: 'Could not reach the server — please try again.' };
  }

  if (!res.ok) {
    if (res.status === 403) {
      let message = 'You do not have access to this analysis.';
      try {
        const body = await res.json();
        if (typeof body?.error === 'string' && body.error) message = body.error;
      } catch { /* keep the default message */ }
      return { ok: false, forbidden: true, errorMessage: message };
    }
    return { ok: false, errorMessage: 'Could not save this — please try again.' };
  }

  return { ok: true, decision };
}
