/**
 * Resume Intelligence (PR B) — the client-side accept/reject/edit flow
 * (docs/resume-pr-b-audit-2026-10-22.md, Finding B). Unit-level, injected
 * `fetch` (no network, no React, no DOM) — proves submitSuggestionDecision()
 * (src/lib/resume/decision-client.ts), the exact function the panel page now
 * calls so its "only update the UI after the server confirms" behaviour is
 * no longer embedded, untestable, inline React state logic.
 *
 * Run: npx tsx test/resume-intelligence-decision-client-suite.ts
 */
import { submitSuggestionDecision } from '../src/lib/resume/decision-client';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }>): { fn: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — DECISION CLIENT (audit Finding B)');
  console.log('='.repeat(78));

  console.log('\nSuccess');
  {
    const { fn, calls } = fakeFetch([{ status: 200, body: { success: true, decisionId: 'd1' } }]);
    const outcome = await submitSuggestionDecision(fn, 'a1', 's1', 'accepted');
    assert(outcome.ok === true && outcome.decision === 'accepted', 'a 200 response is reported as ok with the decision echoed back', JSON.stringify(outcome));
    assert(Boolean(calls[0].body) && (calls[0].body as any).analysisId === 'a1' && (calls[0].body as any).suggestionId === 's1', 'the request body carries the analysisId and suggestionId given to it');
  }

  console.log('\n403 — forbidden, message never leaks the analysis\'s own content');
  {
    const { fn } = fakeFetch([{ status: 403, body: { error: 'You do not have access to this analysis.' } }]);
    const outcome = await submitSuggestionDecision(fn, 'someone-elses-analysis', 's1', 'rejected');
    assert(outcome.ok === false && outcome.forbidden === true, 'a 403 is reported as ok:false, forbidden:true', JSON.stringify(outcome));
    assert(outcome.errorMessage === 'You do not have access to this analysis.', 'the server\'s own generic message is surfaced verbatim (nothing more is added)', outcome.errorMessage);
  }

  console.log('\n403 with a malformed/missing body — still reported forbidden, never throws');
  {
    const { fn } = fakeFetch([{ status: 403, body: undefined }]);
    const outcome = await submitSuggestionDecision(fn, 'a1', 's1', 'rejected');
    assert(outcome.ok === false && outcome.forbidden === true && typeof outcome.errorMessage === 'string' && outcome.errorMessage.length > 0, 'falls back to a safe default message', JSON.stringify(outcome));
  }

  console.log('\n500 — a generic server failure is reported, not confused with "forbidden"');
  {
    const { fn } = fakeFetch([{ status: 500, body: { error: 'Could not record your decision.' } }]);
    const outcome = await submitSuggestionDecision(fn, 'a1', 's1', 'accepted');
    assert(outcome.ok === false && !outcome.forbidden, 'a 500 is ok:false but NOT marked forbidden', JSON.stringify(outcome));
  }

  console.log('\n400 — invalid input rejected by the route');
  {
    const { fn } = fakeFetch([{ status: 400 }]);
    const outcome = await submitSuggestionDecision(fn, '', 's1', 'accepted');
    assert(outcome.ok === false, 'a 400 is reported as a failure');
  }

  console.log('\nNetwork failure (fetch throws) never throws out of this function');
  {
    const throwingFetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    let threw = false;
    let outcome;
    try { outcome = await submitSuggestionDecision(throwingFetch, 'a1', 's1', 'accepted'); } catch { threw = true; }
    assert(!threw, 'a thrown network error is caught, not propagated');
    assert(outcome?.ok === false && typeof outcome?.errorMessage === 'string', 'reported as a failure with a message', JSON.stringify(outcome));
  }

  console.log('\nRetry after a failure: a second attempt for the SAME suggestion can still succeed independently');
  {
    const { fn, calls } = fakeFetch([
      { status: 500, body: { error: 'transient' } },
      { status: 200, body: { success: true, decisionId: 'd2' } },
    ]);
    const first = await submitSuggestionDecision(fn, 'a1', 's1', 'accepted');
    const second = await submitSuggestionDecision(fn, 'a1', 's1', 'accepted');
    assert(first.ok === false && second.ok === true, 'a retry after a failed attempt is independent and can succeed');
    assert(calls.length === 2, 'both attempts reached the server (the server\'s own upsert-on-conflict is what makes a retry idempotent, not client-side suppression)');
  }

  console.log('\n"Concurrent" duplicate submissions (two calls in flight at once) each resolve independently and truthfully');
  {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { success: true, decisionId: 'd3' } },
      { status: 200, body: { success: true, decisionId: 'd3' } },
    ]);
    const [a, b] = await Promise.all([
      submitSuggestionDecision(fn, 'a1', 's1', 'accepted'),
      submitSuggestionDecision(fn, 'a1', 's1', 'accepted'),
    ]);
    assert(a.ok === true && b.ok === true, 'both concurrent calls for the same suggestion resolve ok — the server-side upsert on (analysis_id, suggestion_id) is what makes this safe, not a client lock');
    assert(calls.length === 2, 'both requests were actually sent (this function does not itself dedupe — that responsibility is the page\'s decisionBusy guard plus the server\'s idempotent upsert)');
  }

  console.log('\nEdited text is carried through on success');
  {
    const { fn, calls } = fakeFetch([{ status: 200, body: { success: true, decisionId: 'd4' } }]);
    const outcome = await submitSuggestionDecision(fn, 'a1', 's1', 'edited', 'My edited bullet text.');
    assert(outcome.ok === true && outcome.decision === 'edited', 'an edited decision reports ok with decision="edited"');
    assert((calls[0].body as any).finalText === 'My edited bullet text.', 'the edited text is included in the request body');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
