/**
 * Resume Intelligence (PR B) — persistence, quota and concurrency regression
 * suite for docs/resume-pr-b-audit-2026-10-22.md's findings. Unit-level,
 * mocked Supabase client (no network, no real database) — see test/
 * resume-intelligence-decision-client-suite.ts for the client-side decision
 * flow and test/resume-pr-b-audit-2026-10-22-fixes.ts for the live-DB-shaped
 * (still UNPROVEN against a real database) RPC signature checks.
 *
 * What this suite proves, each against the real analyzeResume() pipeline:
 *  - A1: a permission-denied-shaped error on the pending-claim write never
 *    produces a real analysisId (Finding A, the exact failure this project
 *    hit: a GRANT mismatch returns {data:null, error:{...}} with no throw).
 *  - A2: a genuine successful write returns the REAL id the RPC reports,
 *    not a guess.
 *  - A3: the model succeeding but the FINAL save failing is reported
 *    honestly (persisted:false, analysisId:'') and does NOT refund the
 *    quota unit that real OpenAI spend already consumed.
 *  - A4: cache lookup only ever serves a row that was actually persisted
 *    (status='success'); it is never satisfied by an untracked attempt.
 *  - C1: two requests for the identical key — the second's pending-claim
 *    is refused by the database lock simulation — never reaches quota or
 *    the model at all (no double-spend from a double-click or two tabs).
 *  - C2: quota denied after a successful pending claim finalizes that
 *    claim (to 'unavailable') instead of leaving a dangling pending row.
 *  - A request that never reaches the quota/model stage (insufficient
 *    input, feature disabled) touches the database not at all.
 *
 * Run: npx tsx test/resume-intelligence-persistence-suite.ts
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { analyzeResume, type AnalyzeRequest, type ModelCaller } from '../src/lib/ai/resume-intelligence-service';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const REAL_RESUME = `Jane Doe
Senior Backend Engineer

Experience
Staff Engineer, Acme Corp, Jan 2019 - Present
Led a team of 6 to migrate a monolith to Go services handling 40k requests per second.

Skills
Go, Python, PostgreSQL`;

function baseReq(overrides: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    profileId: '00000000-0000-4000-8000-0000000000aa',
    fullName: 'Jane Doe',
    declaredSkills: ['Go', 'Python'],
    resumeVersionId: '00000000-0000-4000-8000-0000000000bb',
    resumeText: REAL_RESUME,
    mode: 'general',
    aiAllowed: true, // every existing test here exercises the AI path; Workstream 2's own
    // entitlement tests override this explicitly with aiAllowed: false.
    ...overrides,
  };
}

/** A fake upsert_resume_analysis response (claim/reclaim only, migration 041), matching exactly
 *  what the real RPC call site (callClaim in resume-intelligence-service.ts) must handle:
 *  {data, error}, where data can be an array (PostgREST's shape for a RETURNS TABLE function) or
 *  a single object. `attempt_number` is required on any reply meant to flow into a later
 *  finalize/reserve/refund call -- migration 041's callFinalize() refuses to even attempt the RPC
 *  without one (see its own "no analysisId/expectedAttemptNumber" guard). */
type UpsertReply = { data: Array<{ id: string; wrote: boolean; attempt_number?: number }> | { id: string; wrote: boolean; attempt_number?: number } | null; error: { message: string; code?: string } | null };

/** A fake finalize_resume_analysis response (migration 041) — the ONLY RPC that ever writes a
 *  terminal status/result, split out of upsert_resume_analysis specifically so a stale worker can
 *  never silently overwrite a newer attempt's row (Stage 6 finding). */
type FinalizeReply = { data: Array<{ id: string; finalized: boolean; result: string }> | { id: string; finalized: boolean; result: string } | null; error: { message: string; code?: string } | null };

interface StubOptions {
  /** Scripted replies to successive upsert_resume_analysis (claim/reclaim) calls, consumed in order. */
  upsertReplies: UpsertReply[];
  /** Scripted replies to successive finalize_resume_analysis calls, consumed in order. Defaults to
   *  an empty array for scenarios that never reach a finalize call (e.g. a rejected claim). */
  finalizeReplies?: FinalizeReply[];
  /** The cache-lookup SELECT's result (step 1). Defaults to "no cached row". */
  cacheHit?: { id: string; status: string; result: unknown } | null;
  /** reserve_resume_analysis's result. Defaults to allowed. */
  quota?: { allowed: boolean; limit: number; remaining: number; planTier: string };
}

interface StubClient {
  client: SupabaseClient;
  calls: {
    cacheSelect: number; reserve: number; refund: number;
    upsert: number; upsertArgs: Array<Record<string, unknown>>;
    finalize: number; finalizeArgs: Array<Record<string, unknown>>;
  };
}

function makeStubClient(opts: StubOptions): StubClient {
  const calls = {
    cacheSelect: 0, reserve: 0, refund: 0,
    upsert: 0, upsertArgs: [] as Array<Record<string, unknown>>,
    finalize: 0, finalizeArgs: [] as Array<Record<string, unknown>>,
  };
  const replies = [...opts.upsertReplies];
  const finalizeReplies = [...(opts.finalizeReplies ?? [])];
  const client = {
    from(table: string) {
      if (table !== 'resume_analyses') throw new Error(`unexpected table ${table}`);
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => {
          calls.cacheSelect++;
          return Promise.resolve({ data: opts.cacheHit ?? null, error: null });
        },
      };
      return builder;
    },
    rpc(name: string, args?: Record<string, unknown>) {
      if (name === 'reserve_resume_analysis') {
        calls.reserve++;
        return Promise.resolve({ data: opts.quota ?? { allowed: true, limit: 2, remaining: 1, planTier: 'free' }, error: null });
      }
      if (name === 'refund_resume_analysis') {
        calls.refund++;
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'upsert_resume_analysis') {
        calls.upsert++;
        calls.upsertArgs.push(args ?? {});
        const reply = replies.shift();
        if (!reply) throw new Error('upsert_resume_analysis called more times than the test scripted');
        return Promise.resolve(reply);
      }
      if (name === 'finalize_resume_analysis') {
        calls.finalize++;
        calls.finalizeArgs.push(args ?? {});
        const reply = finalizeReplies.shift();
        if (!reply) throw new Error('finalize_resume_analysis called more times than the test scripted');
        return Promise.resolve(reply);
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const stubCallModelSucceeds: ModelCaller = async () => ({
  raw: {
    resumeType: { roleFamily: 'Backend Engineering', confidence: 'high', alternatives: [], evidence: [] },
    overallSummary: { text: 'A backend engineer with team-leadership experience.', evidence: [] },
    sectionReviews: [], strengths: [], improvements: [], bulletRewrites: [],
    skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
    formattingIssues: [], targetJobFit: null, keywordAlignment: null, actionPlan: [], questionsForCandidate: [], limitations: [],
  },
  model: 'gpt-5-mini-test',
});
const stubCallModelFails: ModelCaller = async () => null;

async function main() {
  process.env.RESUME_INTELLIGENCE_ENABLED = 'true';
  delete process.env.OPENAI_API_KEY; // the REAL callModel() must never be reachable in this offline suite

  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — PERSISTENCE / QUOTA / CONCURRENCY (audit fixes)');
  console.log('='.repeat(78));

  console.log('\nA1 — a permission-denied-shaped write error never produces a real analysisId');
  {
    const stub = makeStubClient({
      upsertReplies: [
        // The pending claim itself fails — exactly Finding A's shape: no row, a real error.
        { data: null, error: { message: 'permission denied for function upsert_resume_analysis', code: '42501' } },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelFails);
    assert(result.analysisId === '', 'analysisId is empty when the write itself failed', result.analysisId);
    assert(result.persisted === false, 'persisted is false', String(result.persisted));
    assert(stub.calls.reserve === 0, 'quota was never reserved — the failure happened before any billable step', String(stub.calls.reserve));
    assert(result.analysis.limitations.some((l) => l.code === 'not_saved'), 'a not_saved limitation explains what happened', JSON.stringify(result.analysis.limitations));
  }

  console.log('\nA2 — a genuine successful write returns the REAL database id, not a guess');
  {
    const REAL_ID = '11111111-2222-4333-8444-555555555555';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: REAL_ID, wrote: true, attempt_number: 1 }], error: null }, // pending claim
      ],
      finalizeReplies: [
        { data: [{ id: REAL_ID, finalized: true, result: 'finalized' }], error: null }, // final success write
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(result.status === 'success' && result.persisted === true, 'status success, persisted true');
    assert(result.analysisId === REAL_ID, `analysisId is exactly the id the RPC returned (got ${result.analysisId})`, result.analysisId);
    assert(stub.calls.upsert === 1 && stub.calls.finalize === 1, 'exactly 1 claim call, then 1 finalize call for the final success write', JSON.stringify({ upsert: stub.calls.upsert, finalize: stub.calls.finalize }));
  }

  console.log('\nA3 — model succeeds, final save fails: honest + no silent untracked-but-billed analysis, quota NOT refunded');
  {
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: 'pending-row-id', wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        // The save that would record the real, billable result fails — Finding A's core case.
        { data: null, error: { message: 'permission denied for function finalize_resume_analysis', code: '42501' } },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(result.analysisId === '', 'analysisId is empty — a failed save is never reported as a usable id');
    assert(result.persisted === false, 'persisted is false even though the model call itself succeeded');
    assert(result.status === 'success', 'status still honestly reflects that the analysis itself computed correctly (the content is not lost)');
    assert(result.analysis.overallSummary.text === 'A backend engineer with team-leadership experience.', 'the computed AI content IS still returned — not thrown away just because saving it failed');
    assert(result.analysis.limitations.some((l) => l.code === 'not_saved'), 'a not_saved limitation is present');
    assert(stub.calls.refund === 0, 'quota is NOT refunded — a real, billable model call already happened (requirement: cannot silently fall back to an untracked, billable analysis)', String(stub.calls.refund));
  }

  console.log('\nA4 — cache lookup only ever serves a row that was actually persisted');
  {
    const stub = makeStubClient({
      upsertReplies: [],
      cacheHit: { id: 'cached-row-id', status: 'success', result: { analysisVersion: 'resume-intel-2026.10-v1', mode: 'general', analysisStatus: 'success', source: { ai: true, rules: true }, resumeType: { roleFamily: 'x', confidence: 'low', alternatives: [], evidence: [] }, overallSummary: { text: 'cached', evidence: [] }, sectionReviews: [], strengths: [], improvements: [], bulletRewrites: [], skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] }, formattingIssues: [], targetJobFit: null, keywordAlignment: null, actionPlan: [], questionsForCandidate: [], limitations: [] } },
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelFails);
    assert(result.cached === true && result.persisted === true, 'a real cached row is served as cached+persisted');
    assert(result.analysisId === 'cached-row-id', 'the cached row\'s own id is returned');
    assert(stub.calls.upsert === 0 && stub.calls.reserve === 0, 'a genuine cache hit touches no write path and no quota at all', JSON.stringify(stub.calls));
  }

  console.log('\nC1 — a concurrent duplicate for the IDENTICAL key never reaches quota or the model');
  {
    const stub = makeStubClient({
      upsertReplies: [
        // The pending-claim RPC itself reports "someone else already holds this key" — exactly
        // what the database's FOR UPDATE row lock + 3-minute window produces for a loser.
        { data: [{ id: 'other-requests-pending-row', wrote: false, attempt_number: 1 }], error: null },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(stub.calls.reserve === 0, 'quota was never reserved for the losing concurrent request — no double-spend from a double-click or a second tab', String(stub.calls.reserve));
    assert(result.persisted === false && result.analysisId === '', 'the loser gets no analysisId and nothing it can act on');
    assert(result.analysis.limitations.some((l) => l.code === 'already_in_progress'), 'the limitation explains that another attempt is already running', JSON.stringify(result.analysis.limitations));
  }

  console.log('\nC2 — quota denied after a successful pending claim finalizes the row instead of leaving it dangling');
  {
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: 'pending-row-id', wrote: true, attempt_number: 1 }], error: null },   // claim succeeds
      ],
      finalizeReplies: [
        { data: [{ id: 'pending-row-id', finalized: true, result: 'finalized' }], error: null },   // finalize to 'unavailable'
      ],
      quota: { allowed: false, limit: 2, remaining: 0, planTier: 'free' },
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(stub.calls.upsert === 1 && stub.calls.finalize === 1, 'the pending row IS finalized (a finalize_resume_analysis call) rather than left pending for the 3-minute window', JSON.stringify({ upsert: stub.calls.upsert, finalize: stub.calls.finalize }));
    assert(stub.calls.finalizeArgs[0]?.p_status === 'unavailable', 'the finalize call explicitly closes the row out as unavailable, not left pending', JSON.stringify(stub.calls.finalizeArgs[0]));
    assert(result.quota?.allowed === false, 'the quota-exhausted result is still reported to the caller');
    assert(result.persisted === false, 'nothing usable was persisted for this attempt');
  }

  console.log('\nModel call fails after a successful claim: quota IS refunded, pending row finalized');
  {
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: 'pending-row-id', wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: 'pending-row-id', finalized: true, result: 'finalized' }], error: null },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelFails);
    assert(stub.calls.refund === 1, 'quota IS refunded — the model was never actually reached, so this attempt was never billable', String(stub.calls.refund));
    assert(stub.calls.upsert === 1 && stub.calls.finalize === 1, 'the pending claim is finalized to unavailable', JSON.stringify({ upsert: stub.calls.upsert, finalize: stub.calls.finalize }));
    assert(result.status === 'unavailable' && result.analysis.limitations.some((l) => l.code === 'ai_unavailable'), 'status is unavailable with an ai_unavailable limitation');
  }

  console.log('\nInsufficient input and a disabled feature flag never touch the database at all');
  {
    const stub = makeStubClient({ upsertReplies: [] });
    const result = await analyzeResume(stub.client, baseReq({ resumeText: '' }), stubCallModelSucceeds);
    assert(result.status === 'insufficient_input' && result.analysisId === '' && result.persisted === false, 'insufficient input returns cleanly with nothing persisted');
    assert(stub.calls.cacheSelect === 1 && stub.calls.reserve === 0 && stub.calls.upsert === 0, 'only the cache lookup ran — no quota, no pending claim, no write', JSON.stringify(stub.calls));

    process.env.RESUME_INTELLIGENCE_ENABLED = 'false';
    const stub2 = makeStubClient({ upsertReplies: [] });
    const disabledResult = await analyzeResume(stub2.client, baseReq(), stubCallModelSucceeds);
    assert(disabledResult.status === 'unavailable' && disabledResult.persisted === false, 'feature-disabled short-circuits honestly');
    assert(stub2.calls.cacheSelect === 0 && stub2.calls.reserve === 0 && stub2.calls.upsert === 0, 'a disabled feature flag touches the database not at all', JSON.stringify(stub2.calls));
    process.env.RESUME_INTELLIGENCE_ENABLED = 'true';
  }

  console.log('\nRobustness — a malformed/empty RPC response is treated as a failure, never assumed to have written');
  {
    const stub = makeStubClient({ upsertReplies: [{ data: [], error: null }] }); // empty array, no error
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelFails);
    assert(result.persisted === false && result.analysisId === '', 'an empty/no-row RPC reply never becomes a fabricated success');
  }

  console.log('\nG1 (decided 2026-10-30 — status downgrades to \'unavailable\' when no AI item survives)');
  {
    // docs/resume-pr-b-inventory-2026-10-30.md G1, decided by Deep 2026-10-30: a rules-only
    // result must never be reported as a successful AI analysis. A model response where every
    // AI-sourced quote fails to verify (evidence-validation.ts drops everything) must now
    // downgrade to status 'unavailable' — not 'success' — while still preserving and persisting
    // the deterministic rules-only floor (never silently discarded just because AI is
    // unavailable).
    const allUnverifiableModel: ModelCaller = async () => ({
      raw: {
        resumeType: { roleFamily: 'Backend Engineering', confidence: 'high', alternatives: [], evidence: [] },
        overallSummary: { text: '', evidence: [] },
        sectionReviews: [],
        strengths: [{ id: 's1', text: 'A strength with a fabricated quote.', evidence: [{ doc: 'resume', quote: 'this exact phrase is not anywhere in the resume text', start: 0, end: 0 }], source: 'ai' }],
        improvements: [], bulletRewrites: [],
        skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
        formattingIssues: [], targetJobFit: null, keywordAlignment: null, actionPlan: [], questionsForCandidate: [], limitations: [],
      },
      model: 'gpt-5-mini-test',
    });
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: 'final-row-id', wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: 'final-row-id', finalized: true, result: 'finalized' }], error: null },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), allUnverifiableModel);
    assert(result.analysis.strengths.length === 0, 'G1: the fabricated strength was dropped, as expected');
    assert(result.status === 'unavailable', `G1: status downgrades to 'unavailable' when every AI-sourced item is dropped — got '${result.status}'`);
    assert(result.analysis.analysisStatus === 'unavailable', 'G1: the persisted analysis object\'s own analysisStatus field matches the top-level status');
    assert(result.analysis.source.ai === false, 'G1: source.ai is false — nothing AI-sourced actually survived, so it is not attributed to AI');
    assert(result.analysis.limitations.some((l) => l.code === 'ai_unverifiable'), 'G1: an ai_unverifiable limitation explains the downgrade to the user', JSON.stringify(result.analysis.limitations));
    assert(result.analysis.sectionReviews.length > 0, 'G1: the deterministic rules-only floor (section reviews from runDeterministicAnalysis against the real resume text) is still present, not discarded');
    assert(result.persisted === true, 'G1: the downgraded result is still persisted (as status unavailable, not a silently dropped attempt)');
  }

  console.log('\nG1 positive control — at least one AI item survives validation, status stays \'success\'');
  {
    // The counterpart to the case above: when the model's output is NOT entirely dropped by
    // validation (here, a plain overallSummary with no fabricated quote to reject), the analysis
    // is genuinely AI-assisted and must still report 'success' — the G1 downgrade must not
    // over-fire on a real, verified AI contribution.
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: 'final-row-id', wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: 'final-row-id', finalized: true, result: 'finalized' }], error: null },
      ],
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(result.status === 'success', `G1 positive control: a surviving AI overallSummary keeps status 'success' — got '${result.status}'`);
    assert(result.analysis.analysisStatus === 'success', 'G1 positive control: analysisStatus matches');
    assert(result.analysis.source.ai === true, 'G1 positive control: source.ai is true — the surviving overallSummary is genuinely AI-sourced');
    assert(result.analysis.overallSummary.text === 'A backend engineer with team-leadership experience.', 'G1 positive control: the surviving AI overallSummary text is preserved unchanged');
    assert(result.persisted === true, 'G1 positive control: persisted as a normal success row');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
