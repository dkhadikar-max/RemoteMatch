/**
 * Resume Intelligence — Workstream 2: server-enforced Pro entitlement
 * (docs/resume-pr-b-workstream2-pro-entitlement-plan-2026-10-30.md).
 *
 * Covers Deep's explicit test boundary: Free, Pro, missing profile, invalid tier, and
 * subscription changes — plus the invariant that an unauthorized request never reaches an AI
 * provider (checked against the real orchestration logic, not just the entitlement function
 * in isolation). No network, no database — pure in-process fakes.
 *
 * Two layers tested, matching the two-layer design:
 *   A. Route-level — aiAnalysisAllowed() in src/app/api/resume/analyses/route.ts, against a
 *      fake Supabase client scripting the profiles.plan_tier read.
 *   B. Service-level — analyzeResume()'s own req.aiAllowed branch, against the same
 *      makeStubClient()-style fake used by resume-intelligence-persistence-suite.ts, asserting
 *      the model provider is NEVER invoked and the per-user quota attempt is refunded.
 *
 * Run: npx tsx test/resume-pr-b-workstream2-entitlement-suite.ts
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { aiAnalysisAllowed } from '../src/lib/resume/entitlement';
import { analyzeResume, type AnalyzeRequest, type ModelCaller } from '../src/lib/ai/resume-intelligence-service';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ==============================================================================
// A. Route-level: aiAnalysisAllowed()
// ==============================================================================

/** Fake client scripting a single `.from('profiles').select('plan_tier').eq(...).single()`
 *  read — the exact shape aiAnalysisAllowed() calls. `reply` controls what it returns, or
 *  `throwOnSingle` simulates a DB error (missing profile row, connection failure, etc.). */
function fakeProfileClient(reply: { plan_tier: string | null } | null, throwOnSingle = false): { client: SupabaseClient; singleCalls: number } {
  let singleCalls = 0;
  const client = {
    from(table: string) {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        single: async () => {
          singleCalls++;
          if (throwOnSingle) return { data: null, error: { message: 'missing profile row', code: 'PGRST116' } };
          return { data: reply, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, singleCalls };
}

async function testRouteLevel() {
  console.log('\n=== A. Route-level: aiAnalysisAllowed() ===');

  {
    const { client } = fakeProfileClient({ plan_tier: 'pro' });
    const allowed = await aiAnalysisAllowed(client, 'u-pro');
    assert(allowed === true, "Pro: plan_tier 'pro' is allowed", String(allowed));
  }
  {
    const { client } = fakeProfileClient({ plan_tier: 'free' });
    const allowed = await aiAnalysisAllowed(client, 'u-free');
    assert(allowed === false, "Free: plan_tier 'free' is denied", String(allowed));
  }
  {
    // Missing profile row — .single() errors (Supabase's real behavior on zero rows).
    const { client } = fakeProfileClient(null, true);
    const allowed = await aiAnalysisAllowed(client, 'u-missing');
    assert(allowed === false, 'Missing profile: a DB error on the lookup is denied, never allowed', String(allowed));
  }
  {
    // Invalid/unexpected tier value — must be denied, not treated as a degraded "default allow".
    const { client } = fakeProfileClient({ plan_tier: 'enterprise' });
    const allowed = await aiAnalysisAllowed(client, 'u-invalid-tier');
    assert(allowed === false, "Invalid tier ('enterprise', not 'free'/'pro'): denied, not defaulted to allowed", String(allowed));
  }
  {
    // null plan_tier (a profile row that somehow has no tier set) — must be denied.
    const { client } = fakeProfileClient({ plan_tier: null });
    const allowed = await aiAnalysisAllowed(client, 'u-null-tier');
    assert(allowed === false, 'null plan_tier: denied, never allowed', String(allowed));
  }
  {
    // Subscription change: the SAME user, two consecutive calls with different underlying
    // data — proves there is no caching/memoization that would let a downgrade (or upgrade)
    // go unnoticed until some later point. Each call is a fresh read.
    let tier = 'free';
    let reads = 0;
    const client = {
      from(table: string) {
        if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          single: async () => { reads++; return { data: { plan_tier: tier }, error: null }; },
        };
        return builder;
      },
    } as unknown as SupabaseClient;

    const beforeUpgrade = await aiAnalysisAllowed(client, 'u-sub-change');
    tier = 'pro'; // simulate a Razorpay webhook having just flipped plan_tier
    const afterUpgrade = await aiAnalysisAllowed(client, 'u-sub-change');
    tier = 'free'; // simulate a cancellation
    const afterDowngrade = await aiAnalysisAllowed(client, 'u-sub-change');

    assert(beforeUpgrade === false, 'Subscription change: denied before the upgrade', String(beforeUpgrade));
    assert(afterUpgrade === true, 'Subscription change: allowed immediately after the upgrade (no caching/staleness)', String(afterUpgrade));
    assert(afterDowngrade === false, 'Subscription change: denied again immediately after a downgrade/cancellation', String(afterDowngrade));
    assert(reads === 3, 'Subscription change: 3 separate calls performed 3 separate fresh reads, never memoized', String(reads));
  }
}

// ==============================================================================
// B. Service-level: analyzeResume()'s req.aiAllowed branch
// ==============================================================================

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

function makeStubClient(upsertReplies: UpsertReply[], finalizeReplies: FinalizeReply[] = []) {
  const calls = { reserve: 0, refund: 0, upsert: 0, finalize: 0, modelCalled: 0 };
  const replies = [...upsertReplies];
  const fReplies = [...finalizeReplies];
  const client = {
    from(table: string) {
      if (table !== 'resume_analyses') throw new Error(`unexpected table ${table}`);
      const builder: any = { select: () => builder, eq: () => builder, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return builder;
    },
    rpc(name: string) {
      if (name === 'reserve_resume_analysis') { calls.reserve++; return Promise.resolve({ data: { allowed: true, limit: 10, remaining: 9, planTier: 'pro' }, error: null }); }
      if (name === 'refund_resume_analysis') { calls.refund++; return Promise.resolve({ data: null, error: null }); }
      if (name === 'upsert_resume_analysis') {
        calls.upsert++;
        const reply = replies.shift();
        if (!reply) throw new Error('upsert_resume_analysis called more times than scripted');
        return Promise.resolve(reply);
      }
      if (name === 'finalize_resume_analysis') {
        calls.finalize++;
        const reply = fReplies.shift();
        if (!reply) throw new Error('finalize_resume_analysis called more times than scripted');
        return Promise.resolve(reply);
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

async function testServiceLevel() {
  console.log('\n=== B. Service-level: analyzeResume()\'s req.aiAllowed branch ===');
  process.env.RESUME_INTELLIGENCE_ENABLED = 'true';
  delete process.env.OPENAI_API_KEY;

  const modelCallerSpy: { calls: number } = { calls: 0 };
  const trackingModelCaller: ModelCaller = async () => {
    modelCallerSpy.calls++;
    // G1 (decided 2026-10-30): status downgrades to 'unavailable' when EVERY AI-sourced field
    // is empty — so this fixture needs real surviving content, matching
    // resume-intelligence-persistence-suite.ts's own stubCallModelSucceeds fixture, or this
    // "Pro" test case would downgrade for an unrelated reason and mask what it's testing.
    return { raw: { resumeType: { roleFamily: 'x', confidence: 'low', alternatives: [], evidence: [] }, overallSummary: { text: 'A backend engineer with team-leadership experience.', evidence: [] }, sectionReviews: [], strengths: [], improvements: [], bulletRewrites: [], skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] }, formattingIssues: [], targetJobFit: null, keywordAlignment: null, actionPlan: [], questionsForCandidate: [], limitations: [] }, model: 'test' };
  };

  {
    modelCallerSpy.calls = 0;
    const stub = makeStubClient(
      [{ data: [{ id: 'pending-1', wrote: true, attempt_number: 1 }], error: null }], // pending claim
      [{ data: [{ id: 'final-1', finalized: true, result: 'finalized' }], error: null }],   // final (unavailable) write
    );
    const result = await analyzeResume(stub.client, baseReq({ aiAllowed: false }), trackingModelCaller);
    assert(modelCallerSpy.calls === 0, 'Free (aiAllowed:false): the model provider is NEVER invoked', String(modelCallerSpy.calls));
    assert(stub.calls.reserve === 1, 'Free: the per-user quota IS still reserved (unchanged pre-existing behavior)', String(stub.calls.reserve));
    assert(stub.calls.refund === 1, 'Free: the quota reservation IS refunded (entitlement denial is a "failed before reaching the model" case)', String(stub.calls.refund));
    assert(result.status === 'unavailable', `Free: status is 'unavailable' (got ${result.status})`, result.status);
    assert(result.analysis.limitations.some((l) => l.code === 'upgrade_required'), 'Free: an upgrade_required limitation is present', JSON.stringify(result.analysis.limitations));
    assert(result.analysis.sectionReviews.length >= 0 && result.analysis.source.rules === true, 'Free: the deterministic rules-only floor is still present', JSON.stringify(result.analysis.source));
    assert(result.analysis.source.ai !== true, 'Free: source.ai is never true for an entitlement-denied result', JSON.stringify(result.analysis.source));
  }

  {
    modelCallerSpy.calls = 0;
    const stub = makeStubClient(
      [{ data: [{ id: 'pending-2', wrote: true, attempt_number: 1 }], error: null }],
      [{ data: [{ id: 'final-2', finalized: true, result: 'finalized' }], error: null }],
    );
    const result = await analyzeResume(stub.client, baseReq({ aiAllowed: true }), trackingModelCaller);
    assert(modelCallerSpy.calls === 1, 'Pro (aiAllowed:true): the model provider IS invoked exactly once', String(modelCallerSpy.calls));
    assert(stub.calls.refund === 0, 'Pro: no spurious refund — the attempt genuinely proceeded', String(stub.calls.refund));
    assert(result.status === 'success', `Pro: status is 'success' (got ${result.status})`, result.status);
    assert(!result.analysis.limitations.some((l) => l.code === 'upgrade_required'), 'Pro: no upgrade_required limitation', JSON.stringify(result.analysis.limitations));
  }
}

async function main() {
  await testRouteLevel();
  await testServiceLevel();
  console.log(`\n==============================================================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`==============================================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
