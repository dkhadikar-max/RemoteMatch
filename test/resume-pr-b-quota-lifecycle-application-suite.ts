/**
 * Resume Intelligence (PR B) — Stage 2 dynamic regression suite for the application-layer
 * wiring of migration 040's per-attempt quota lifecycle (resume-intelligence-service.ts).
 *
 * Scope: this suite exercises analyzeResume() against a mocked SupabaseClient — no real
 * Postgres is used. It verifies the thing only the application layer can get wrong: that the
 * EXACT attempt_number captured from the step-3 pending claim is the one threaded through to
 * reserve_resume_analysis, and the SAME value (not re-read, not re-derived) is threaded through
 * to refund_resume_analysis on every refund path — never a value from a later finalize call,
 * which the real RPC advances again. The RPCs' own idempotency/ordering/rollover behavior is
 * covered separately by test/resume-pr-b-quota-lifecycle-migration-static-suite.ts (static) and
 * is NOT re-verified here.
 *
 * Run: npx tsx test/resume-pr-b-quota-lifecycle-application-suite.ts
 */
import { analyzeResume, type AnalyzeRequest, type ModelCaller } from '../src/lib/ai/resume-intelligence-service';
import type { SupabaseClient } from '@supabase/supabase-js';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: string) {
  if (condition) { console.log(`  ✓ PASS: ${message}`); passed++; }
  else { console.error(`  ✗ FAIL: ${message}${detail ? ` — ${detail}` : ''}`); failed++; }
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
    aiAllowed: true,
    ...overrides,
  };
}

type UpsertReply = { data: Array<{ id: string; wrote: boolean; attempt_number?: number }> | { id: string; wrote: boolean; attempt_number?: number } | null; error: { message: string; code?: string } | null };
type FinalizeReply = { data: Array<{ id: string; finalized: boolean; result: string }> | { id: string; finalized: boolean; result: string } | null; error: { message: string; code?: string } | null };

interface StubOptions {
  upsertReplies: UpsertReply[];
  /** Migration 041 split finalize out of upsert_resume_analysis -- scripted replies to
   *  successive finalize_resume_analysis calls, consumed in order. Most scenarios just need one
   *  clean 'finalized' reply; defaults to an empty array for scenarios that never reach finalize. */
  finalizeReplies?: FinalizeReply[];
  cacheHit?: { id: string; status: string; result: unknown } | null;
  quota?: { allowed: boolean; limit: number; remaining: number; planTier: string };
  /** Stage 5 fix #2 test support: when set, EVERY reserve_resume_analysis call (including the
   *  Stage 6 retry) returns this as `error` with `data: null` -- a persistent transport/RPC
   *  failure, simulating a genuinely unreachable database, not a one-off blip. */
  reserveError?: { message: string; code?: string } | null;
  /** Stage 6 fix test support: the first N reserve_resume_analysis calls return an error; calls
   *  after that succeed. 0 (default) means reserve always succeeds immediately. Distinct from
   *  `reserveError` above, which fails every call unconditionally. */
  reserveErrorCount?: number;
  /** Stage 5 fix #3 test support: the first N refund_resume_analysis calls return an error; calls
   *  after that succeed. 0 (default) means refund always succeeds immediately. */
  refundErrorCount?: number;
}

interface RpcCallRecord { name: string; args: Record<string, unknown> | undefined }

function makeStubClient(opts: StubOptions) {
  const rpcCalls: RpcCallRecord[] = [];
  const replies = [...opts.upsertReplies];
  const finalizeReplies = [...(opts.finalizeReplies ?? [])];
  const reserveError = opts.reserveError ?? null;
  const reserveErrorCount = opts.reserveErrorCount ?? 0;
  let reserveCallCount = 0;
  const refundErrorCount = opts.refundErrorCount ?? 0;
  let refundCallCount = 0;
  const client = {
    from(table: string) {
      if (table !== 'resume_analyses') throw new Error(`unexpected table ${table}`);
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: opts.cacheHit ?? null, error: null }),
      };
      return builder;
    },
    rpc(name: string, args?: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === 'reserve_resume_analysis') {
        reserveCallCount++;
        if (reserveError) return Promise.resolve({ data: null, error: reserveError });
        if (reserveCallCount <= reserveErrorCount) {
          return Promise.resolve({ data: null, error: { message: 'simulated transport failure', code: '57014' } });
        }
        return Promise.resolve({ data: opts.quota ?? { allowed: true, limit: 2, remaining: 1, planTier: 'free' }, error: null });
      }
      if (name === 'refund_resume_analysis') {
        refundCallCount++;
        if (refundCallCount <= refundErrorCount) {
          return Promise.resolve({ data: null, error: { message: 'simulated transport failure', code: '57014' } });
        }
        return Promise.resolve({ data: { result: 'refunded' }, error: null });
      }
      if (name === 'upsert_resume_analysis') {
        const reply = replies.shift();
        if (!reply) throw new Error('upsert_resume_analysis called more times than the test scripted');
        return Promise.resolve(reply);
      }
      if (name === 'finalize_resume_analysis') {
        const reply = finalizeReplies.shift();
        if (!reply) throw new Error('finalize_resume_analysis called more times than the test scripted');
        return Promise.resolve(reply);
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
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
  delete process.env.OPENAI_API_KEY;

  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — QUOTA LIFECYCLE APPLICATION WIRING (migration 040)');
  console.log('='.repeat(78));

  console.log('\n1. reserve_resume_analysis is called with the claim\'s own id + attempt_number');
  {
    const CLAIM_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 7 }], error: null },   // step 3: pending claim
      ],
      finalizeReplies: [
        { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },   // final success write
      ],
    });
    await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    const reserveCall = stub.rpcCalls.find((c) => c.name === 'reserve_resume_analysis');
    assert(!!reserveCall, 'reserve_resume_analysis was called');
    assert(reserveCall?.args?.p_analysis_id === CLAIM_ID, 'reserve_resume_analysis received the claim\'s own row id', JSON.stringify(reserveCall?.args));
    assert(reserveCall?.args?.p_attempt_number === 7, 'reserve_resume_analysis received the attempt_number from the STEP-3 CLAIM (7), not any later value', JSON.stringify(reserveCall?.args));
  }

  console.log('\n2. entitlement denial: refund carries the SAME attempt_number as the claim, with reason upgrade_required');
  {
    const CLAIM_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 3 }], error: null },   // step 3: pending claim
      ],
      finalizeReplies: [
        { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },   // finalize to 'unavailable'
      ],
    });
    await analyzeResume(stub.client, baseReq({ aiAllowed: false }), stubCallModelSucceeds);
    const refundCall = stub.rpcCalls.find((c) => c.name === 'refund_resume_analysis');
    assert(!!refundCall, 'refund_resume_analysis was called on entitlement denial');
    assert(refundCall?.args?.p_analysis_id === CLAIM_ID, 'refund carries the claim\'s row id');
    assert(refundCall?.args?.p_attempt_number === 3, 'refund carries attempt_number 3 (the claim\'s value) — the ONLY attempt number this request ever holds, now that finalize no longer advances it', JSON.stringify(refundCall?.args));
    assert(refundCall?.args?.p_reason === 'upgrade_required', 'refund reason is upgrade_required', JSON.stringify(refundCall?.args));

    // The refund must happen strictly BEFORE the finalize call in call order, so a crash
    // between them still leaves a refund event recorded against the live (not-yet-finalized) row.
    const refundIdx = stub.rpcCalls.findIndex((c) => c.name === 'refund_resume_analysis');
    const finalizeIdx = stub.rpcCalls.findIndex((c) => c.name === 'finalize_resume_analysis');
    assert(refundIdx < finalizeIdx, 'refund is issued before the finalize call', `refund@${refundIdx}, finalize@${finalizeIdx}`);
  }

  console.log('\n3. model unavailable: refund carries the SAME attempt_number as the claim, with reason ai_unavailable');
  {
    const CLAIM_ID = 'cccccccc-3333-4333-8333-333333333333';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
      ],
    });
    await analyzeResume(stub.client, baseReq(), stubCallModelFails);
    const refundCall = stub.rpcCalls.find((c) => c.name === 'refund_resume_analysis');
    assert(!!refundCall, 'refund_resume_analysis was called when the model call failed');
    assert(refundCall?.args?.p_attempt_number === 1, 'refund carries attempt_number 1 (the claim\'s value)', JSON.stringify(refundCall?.args));
    assert(refundCall?.args?.p_reason === 'ai_unavailable', 'refund reason is ai_unavailable', JSON.stringify(refundCall?.args));
  }

  console.log('\n4. quota exhausted: reserve is called, but refund is NEVER called (nothing was reserved to refund)');
  {
    const CLAIM_ID = 'dddddddd-4444-4444-8444-444444444444';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 5 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
      ],
      quota: { allowed: false, limit: 2, remaining: 0, planTier: 'free' },
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(result.analysis.limitations.some((l) => l.code === 'quota_exhausted'), 'quota_exhausted limitation is reported');
    const reserveCall = stub.rpcCalls.find((c) => c.name === 'reserve_resume_analysis');
    assert(reserveCall?.args?.p_attempt_number === 5, 'reserve was still called with the correct attempt_number even though it was denied', JSON.stringify(reserveCall?.args));
    assert(!stub.rpcCalls.some((c) => c.name === 'refund_resume_analysis'), 'refund_resume_analysis is never called when reservation itself was denied — limit_reached leaves no reserved event to refund');
  }

  console.log('\n5. callUpsert attemptNumber back-compat: an upsert reply without attempt_number never throws, degrades to null');
  {
    const CLAIM_ID = 'eeeeeeee-5555-4555-8555-555555555555';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true }], error: null },   // no attempt_number field at all
      ],
      // No finalizeReplies entry needed: callFinalize's own guard (migration 041) skips the RPC
      // entirely when expectedAttemptNumber is null, rather than ever sending it to the server.
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(result.status === 'success', 'analyzeResume still completes successfully when attempt_number is absent from a mocked/legacy reply (status reflects the computed content regardless of whether it could be persisted)');
    const reserveCall = stub.rpcCalls.find((c) => c.name === 'reserve_resume_analysis');
    assert(reserveCall?.args?.p_attempt_number === null, 'reserve is called with p_attempt_number: null rather than throwing, when the claim reply omitted attempt_number', JSON.stringify(reserveCall?.args));
  }

  console.log('\n6. Stage 5 finding #2: a reserve_resume_analysis transport error is distinguished from a real quota_exhausted');
  {
    const CLAIM_ID = 'ffffffff-6666-4666-8666-666666666666';
    const stub = makeStubClient({
      upsertReplies: [
        { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 1 }], error: null },
      ],
      finalizeReplies: [
        { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
      ],
      reserveError: { message: 'simulated transport failure', code: '57014' },
    });
    const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
    assert(!result.analysis.limitations.some((l) => l.code === 'quota_exhausted'), 'a transport error is NEVER mislabeled as quota_exhausted');
    assert(result.analysis.limitations.some((l) => l.code === 'reservation_failed'), 'a transport error is reported as its own distinct reservation_failed limitation', JSON.stringify(result.analysis.limitations));
    assert(!stub.rpcCalls.some((c) => c.name === 'refund_resume_analysis'), 'no refund is attempted -- the reservation itself never succeeded, so there is nothing to give back');
    const reserveCalls = stub.rpcCalls.filter((c) => c.name === 'reserve_resume_analysis');
    assert(reserveCalls.length === 2, 'Stage 6 fix: a PERSISTENT reserve failure is retried once (1 original + 1 retry) before giving up, same pattern as refund', String(reserveCalls.length));
  }

  console.log('\n8. Stage 6 fix: a reserve_resume_analysis failure is retried once with IDENTICAL identifiers, then recovers');
  {
    const CLAIM_ID = 'cccccccc-9999-4999-8999-999999999999';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      const stub = makeStubClient({
        upsertReplies: [
          { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 4 }], error: null },
        ],
        finalizeReplies: [
          { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
        ],
        reserveErrorCount: 1,
      });
      const result = await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
      const reserveCalls = stub.rpcCalls.filter((c) => c.name === 'reserve_resume_analysis');
      assert(reserveCalls.length === 2, 'a one-off reserve failure is retried exactly once', String(reserveCalls.length));
      assert(JSON.stringify(reserveCalls[0].args) === JSON.stringify(reserveCalls[1].args), 'the retry uses the EXACT same analysis_id/attempt_number -- per the spec, never a new attempt just because the response was lost', JSON.stringify(reserveCalls[0].args));
      assert(reserveCalls[0].args?.p_attempt_number === 4, 'the identifiers used are the real claim attempt_number (4), not a re-derived or incremented one');
      assert(result.status === 'success', 'the request proceeds normally once the retry succeeds -- the one-off failure is fully recovered, not just logged');
      assert(warnings.length === 0, 'no warning is logged when the retry recovers -- only a persistent double-failure is noteworthy');
    } finally {
      console.warn = originalWarn;
    }
  }
  {
    const CLAIM_ID = 'dddddddd-0000-4000-8000-000000000000';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      const stub = makeStubClient({
        upsertReplies: [
          { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 1 }], error: null },
        ],
        finalizeReplies: [
          { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
        ],
        reserveErrorCount: 2,
      });
      await analyzeResume(stub.client, baseReq(), stubCallModelSucceeds);
      const reserveCalls = stub.rpcCalls.filter((c) => c.name === 'reserve_resume_analysis');
      assert(reserveCalls.length === 2, 'exactly 2 attempts are made (1 original + 1 retry), never an unbounded retry loop', String(reserveCalls.length));
      assert(warnings.some((w) => w.includes('reserve_resume_analysis failed twice')), 'a persistent reserve failure is logged (visible), not silently swallowed', JSON.stringify(warnings));
    } finally {
      console.warn = originalWarn;
    }
  }

  console.log('\n9. Stage 5 finding #3: a refund_resume_analysis failure is retried once, then logged (never silently swallowed)');
  {
    const CLAIM_ID = 'aaaaaaaa-7777-4777-8777-777777777777';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      // First refund call fails, the retry succeeds.
      const stub = makeStubClient({
        upsertReplies: [
          { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 1 }], error: null },
        ],
        finalizeReplies: [
          { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
        ],
        refundErrorCount: 1,
      });
      await analyzeResume(stub.client, baseReq({ aiAllowed: false }), stubCallModelSucceeds);
      const refundCalls = stub.rpcCalls.filter((c) => c.name === 'refund_resume_analysis');
      assert(refundCalls.length === 2, 'a failed refund is retried exactly once with the IDENTICAL arguments (idempotent, safe to retry)', String(refundCalls.length));
      assert(JSON.stringify(refundCalls[0].args) === JSON.stringify(refundCalls[1].args), 'the retry uses the exact same analysis_id/attempt_number/reason as the original call');
      assert(warnings.length === 0, 'no warning is logged when the retry succeeds -- only a persistent double-failure is noteworthy');
    } finally {
      console.warn = originalWarn;
    }
  }
  {
    const CLAIM_ID = 'bbbbbbbb-8888-4888-8888-888888888888';
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      // Both refund attempts fail.
      const stub = makeStubClient({
        upsertReplies: [
          { data: [{ id: CLAIM_ID, wrote: true, attempt_number: 1 }], error: null },
        ],
        finalizeReplies: [
          { data: [{ id: CLAIM_ID, finalized: true, result: 'finalized' }], error: null },
        ],
        refundErrorCount: 2,
      });
      const result = await analyzeResume(stub.client, baseReq(), stubCallModelFails);
      const refundCalls = stub.rpcCalls.filter((c) => c.name === 'refund_resume_analysis');
      assert(refundCalls.length === 2, 'exactly 2 attempts are made (1 original + 1 retry), never an unbounded retry loop', String(refundCalls.length));
      assert(warnings.some((w) => w.includes('refund_resume_analysis failed twice')), 'a persistent refund failure is logged (visible), not silently swallowed', JSON.stringify(warnings));
      assert(result.status === 'unavailable', 'the request still completes and reports a result to the user even though the refund itself could not be confirmed');
    } finally {
      console.warn = originalWarn;
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
