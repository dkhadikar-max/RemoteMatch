/**
 * Resume Intelligence (PR B) — authenticated application smoke test against
 * a real running server + a real, EXPLICITLY ISOLATED Supabase test project.
 * Never run against production.
 *
 * IMPORTANT, HONEST LIMITATION: no Gemini/OpenAI credentials were available
 * (or added — real AI spend is governed by a separate, settled cost policy
 * this task did not authorize touching) for this run. So the genuine
 * model-round-trip ("the AI call itself succeeds") cannot be exercised here.
 * Section 1 instead proves the real, live reserve -> refund -> finalize
 * path (upgrade_required for Free, ai_unavailable for Pro — both are real
 * code paths in src/lib/ai/resume-intelligence-service.ts, not mocks), and
 * section 4 proves the quota-CONSUMPTION side (no refund) by calling the
 * exact same RPCs the app calls, as a real authenticated user, with a
 * status:'success' finalize — i.e. everything EXCEPT the literal outbound
 * HTTP call to the model provider. The model call itself is the one gap
 * this suite does not and cannot close without real provider credentials.
 *
 * Run only after starting the app against the isolated project:
 * NEXT_PUBLIC_SUPABASE_URL=https://xyahktsgdigutxartafb.supabase.co
 * TEST_SERVER_SUPABASE_PROJECT_REF=xyahktsgdigutxartafb
 * TEST_BASE_URL=http://localhost:3000 npx tsx test/resume-intelligence-app-smoke-isolated-suite.ts
 */
import { hasRequiredEnv, adminClient, anonKeyClient, uniqueEmail } from './helpers/verified-session';
import { RESUME_ANALYSIS_VERSION } from '../src/types/resume-intelligence';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ISOLATED_PROJECT_REF = 'xyahktsgdigutxartafb';

function assertIsolatedTarget(): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serverProjectRef = process.env.TEST_SERVER_SUPABASE_PROJECT_REF;
  if (!supabaseUrl || new URL(supabaseUrl).hostname !== `${ISOLATED_PROJECT_REF}.supabase.co`) {
    throw new Error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL must target isolated project ${ISOLATED_PROJECT_REF}.`);
  }
  if (serverProjectRef !== ISOLATED_PROJECT_REF) {
    throw new Error(`Refusing to run: set TEST_SERVER_SUPABASE_PROJECT_REF=${ISOLATED_PROJECT_REF} only after starting the app with that same Supabase project.`);
  }
  const base = new URL(BASE_URL);
  if (!['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new Error('Refusing to run: TEST_BASE_URL must be a local loopback address.');
  }
}

async function createTrackedSession(cleanupUserIds: string[]) {
  const email = uniqueEmail();
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Could not create verified test user: ${error?.message ?? 'missing user'}`);
  cleanupUserIds.push(data.user.id); // Track immediately, before sign-in can fail.
  const client = anonKeyClient();
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session) throw new Error(`Could not sign in test user ${data.user.id}: ${signInError?.message ?? 'missing session'}`);
  return { client, userId: data.user.id, email, password, token: signedIn.session.access_token };
}
let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

async function post(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}
async function get(path: string, token: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const SAMPLE_RESUME = `Jane Doe
Senior Software Engineer

Experience:
- Built and shipped a distributed payments system handling 50k tx/day.
- Led a team of 4 engineers across two product launches.
- Reduced API p99 latency by 40% through caching and query optimization.

Skills: TypeScript, PostgreSQL, React, AWS, Kubernetes`;

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE — AUTHENTICATED APPLICATION SMOKE TEST (isolated project only)');
  console.log('='.repeat(78));

  if (!hasRequiredEnv() || !process.env.TEST_BASE_URL) {
    console.error('TEST_BASE_URL / Supabase env not all set — this suite requires a live isolated project and refuses to silently no-op.');
    process.exitCode = 1;
    return;
  }
  try {
    assertIsolatedTarget();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const admin = adminClient();
  const cleanupUserIds: string[] = [];

  try {
    // --- 1a. Resume upload, round-trip, and Free-tier analysis -> real reserve/refund path ---
    console.log('\n1. Resume upload + Free-tier analysis (real reserve -> refund -> finalize, no AI call)');
    const freeSession = await createTrackedSession(cleanupUserIds);
    // newVerifiedSession() leaves plan_tier at its table default ('free') — confirmed directly below.
    const { data: freeProfileBefore } = await admin.from('profiles').select('plan_tier, daily_resume_analyses_count').eq('id', freeSession.userId).single();
    assert(freeProfileBefore?.plan_tier === 'free', `fixture user is really Free tier (got ${freeProfileBefore?.plan_tier})`);

    const uploadRes = await post('/api/resume/versions', freeSession.token, { content: SAMPLE_RESUME, source: 'paste' });
    assert(uploadRes.status === 200 && Boolean(uploadRes.body?.versionId), `resume upload succeeds (got ${uploadRes.status})`);
    const versionId = uploadRes.body.versionId as string;

    const getRes = await get('/api/resume/versions', freeSession.token);
    assert(getRes.status === 200 && getRes.body?.content === SAMPLE_RESUME, 'uploaded resume round-trips correctly on GET (exact content match)');

    const countBefore = freeProfileBefore?.daily_resume_analyses_count ?? 0;
    const analyzeRes = await post('/api/resume/analyses', freeSession.token, { resumeVersionId: versionId, mode: 'general' });
    assert(analyzeRes.status === 200 && analyzeRes.body?.success === true, `analysis request completes (got ${analyzeRes.status})`);
    assert(
      analyzeRes.body?.analysis?.limitations?.some((l: { code: string }) => l.code === 'upgrade_required'),
      'Free-tier analysis correctly reports upgrade_required (real server-side entitlement check, not a client flag)'
    );
    assert(Boolean(analyzeRes.body?.analysis?.automatedChecks ?? analyzeRes.body?.analysis), 'the deterministic rules-only analysis floor is still present even though AI was withheld');

    const { data: freeProfileAfter } = await admin.from('profiles').select('daily_resume_analyses_count').eq('id', freeSession.userId).single();
    assert((freeProfileAfter?.daily_resume_analyses_count ?? 0) === countBefore, `quota is net-ZERO after the entitlement-denial refund (before=${countBefore}, after=${freeProfileAfter?.daily_resume_analyses_count})`);

    const { data: freeQuotaEvents } = await admin
      .from('resume_quota_events')
      .select('event_type, reason')
      .eq('analysis_id', analyzeRes.body.analysisId)
      .order('created_at', { ascending: true });
    assert((freeQuotaEvents ?? []).some((e) => e.event_type === 'reserved'), 'a real "reserved" quota event was written');
    assert((freeQuotaEvents ?? []).some((e) => e.event_type === 'refunded' && e.reason === 'upgrade_required'), 'a real "refunded" quota event was written with reason=upgrade_required');

    // --- 1b. Pro-tier analysis -> real reserve/refund path (ai_unavailable, no keys configured) ---
    console.log('\n1b. Pro-tier analysis (real reserve -> refund -> finalize, ai_unavailable — no provider keys configured)');
    const proSession = await createTrackedSession(cleanupUserIds);
    const { error: upgradeErr } = await admin.from('profiles').update({ plan_tier: 'pro' }).eq('id', proSession.userId);
    assert(!upgradeErr, `fixture user upgraded to Pro (${upgradeErr?.message ?? 'ok'})`);

    const proUploadRes = await post('/api/resume/versions', proSession.token, { content: SAMPLE_RESUME, source: 'paste' });
    const proVersionId = proUploadRes.body.versionId as string;
    const proAnalyzeRes = await post('/api/resume/analyses', proSession.token, { resumeVersionId: proVersionId, mode: 'general' });
    assert(proAnalyzeRes.status === 200 && proAnalyzeRes.body?.success === true, `Pro analysis request completes (got ${proAnalyzeRes.status})`);
    assert(
      proAnalyzeRes.body?.analysis?.limitations?.some((l: { code: string }) => l.code === 'ai_unavailable'),
      'Pro-tier analysis (no provider keys configured) correctly reports ai_unavailable, not upgrade_required — proves entitlement was genuinely granted before the model step'
    );
    const { data: proQuotaEvents } = await admin
      .from('resume_quota_events')
      .select('event_type, reason, attempt_number')
      .eq('analysis_id', proAnalyzeRes.body.analysisId);
    assert((proQuotaEvents ?? []).some((e) => e.event_type === 'reserved'), 'Pro path writes a real reserved event');
    assert((proQuotaEvents ?? []).some((e) => e.event_type === 'refunded' && e.reason === 'ai_unavailable'), 'Pro path refunds with reason=ai_unavailable (distinct from Free\'s upgrade_required — proves these are different real code branches, not the same stub)');

    // --- 2. Ownership boundary: a different user cannot analyze (or even see) someone else's resume version ---
    console.log('\n2. Ownership boundary — a different user cannot touch the first user\'s resume version');
    const otherSession = await createTrackedSession(cleanupUserIds);
    const crossUserRes = await post('/api/resume/analyses', otherSession.token, { resumeVersionId: versionId, mode: 'general' });
    assert(crossUserRes.status === 404, `a different user requesting analysis of the FIRST user's resumeVersionId gets 404 (got ${crossUserRes.status}) — RLS-backed ownership enforced through the real HTTP route`);

    const { data: crossUserDirectRead } = await otherSession.client.from('resume_versions').select('id').eq('id', versionId);
    assert((crossUserDirectRead ?? []).length === 0, 'the other user\'s own session client cannot read the first user\'s resume_versions row directly either (RLS, not just route-level filtering)');

    // --- 3. True concurrent duplicate-claim race (retry/concurrency safety) ---
    console.log('\n3. Two truly concurrent identical analysis requests — exactly one proceeds, the other is told to wait');
    const raceSession = await createTrackedSession(cleanupUserIds);
    const raceUpload = await post('/api/resume/versions', raceSession.token, { content: SAMPLE_RESUME, source: 'paste' });
    const raceVersionId = raceUpload.body.versionId as string;

    const [raceA, raceB] = await Promise.all([
      post('/api/resume/analyses', raceSession.token, { resumeVersionId: raceVersionId, mode: 'general' }),
      post('/api/resume/analyses', raceSession.token, { resumeVersionId: raceVersionId, mode: 'general' }),
    ]);
    const raceCodes = [raceA, raceB].map((r) => (r.body?.analysis?.limitations ?? []).map((l: { code: string }) => l.code));
    const oneGotUpgradeRequired = raceCodes.some((codes) => codes.includes('upgrade_required'));
    const otherGotAlreadyInProgress = raceCodes.some((codes) => codes.includes('already_in_progress'));
    assert(oneGotUpgradeRequired && otherGotAlreadyInProgress, `exactly one concurrent request reaches the real entitlement check, the other is told a claim is already in progress (got ${JSON.stringify(raceCodes)})`);

    // --- 4. Genuine quota CONSUMPTION (no refund) when an attempt finalizes as success ---
    // This calls the exact same RPCs src/lib/ai/resume-intelligence-service.ts calls, as the
    // SAME real authenticated user (never service-role — these RPCs raise 'unauthenticated'
    // for a null auth.uid(), so this could not be faked via service-role even if attempted),
    // skipping only the literal outbound HTTP call to the model provider.
    console.log('\n4. Genuine quota consumption (no refund) on a finalized success — RPCs only, no provider HTTP call');
    const consumeSession = await createTrackedSession(cleanupUserIds);
    const { data: consumeBefore } = await admin.from('profiles').select('daily_resume_analyses_count').eq('id', consumeSession.userId).single();
    const consumeCountBefore = consumeBefore?.daily_resume_analyses_count ?? 0;

    const consumeUpload = await post('/api/resume/versions', consumeSession.token, { content: SAMPLE_RESUME, source: 'paste' });
    const consumeVersionId = consumeUpload.body.versionId as string;
    const { data: claimRow, error: claimErr } = await consumeSession.client.rpc('upsert_resume_analysis', {
      p_resume_version_id: consumeVersionId,
      p_mode: 'general',
      p_opportunity_id: null,
      p_job_content_hash: '',
      p_analysis_version: RESUME_ANALYSIS_VERSION,
    });
    const claim = Array.isArray(claimRow) ? claimRow[0] : claimRow;
    assert(!claimErr && Boolean(claim?.id), `direct claim RPC succeeds (${claimErr?.message ?? 'ok'})`);

    const { data: reserveResult } = await consumeSession.client.rpc('reserve_resume_analysis', { p_analysis_id: claim.id, p_attempt_number: claim.attempt_number });
    assert((reserveResult as { allowed?: boolean })?.allowed === true, `direct reserve RPC succeeds (${JSON.stringify(reserveResult)})`);

    const { data: finalizeResult, error: finalizeErr } = await consumeSession.client.rpc('finalize_resume_analysis', {
      p_analysis_id: claim.id,
      p_expected_attempt_number: claim.attempt_number,
      p_status: 'success',
      p_result: { automatedChecks: [], aiSuggestions: [], analysisStatus: 'success', limitations: [] },
      p_source_ai: true,
      p_model: 'smoke-test-fixture',
      p_prompt_tokens: 1,
      p_completion_tokens: 1,
      p_cost_usd: 0,
    });
    const finalized = Array.isArray(finalizeResult) ? finalizeResult[0] : finalizeResult;
    assert(!finalizeErr && finalized?.finalized === true && finalized?.result === 'finalized', `direct finalize(status=success) is confirmed finalized (${finalizeErr?.message ?? JSON.stringify(finalizeResult)})`);
    const { data: persistedSuccess, error: persistedSuccessErr } = await admin.from('resume_analyses').select('status, source_ai, model, attempt_number').eq('id', claim.id).single();
    assert(!persistedSuccessErr && persistedSuccess?.status === 'success', 'finalized analysis row is persisted with status=success');
    assert(persistedSuccess?.source_ai === true && persistedSuccess?.model === 'smoke-test-fixture', 'finalized row records source_ai=true and the smoke-test model marker');
    assert(persistedSuccess?.attempt_number === claim.attempt_number, 'finalization does not increment or replace the claimed attempt number');

    const { data: consumeAfter } = await admin.from('profiles').select('daily_resume_analyses_count').eq('id', consumeSession.userId).single();
    assert((consumeAfter?.daily_resume_analyses_count ?? 0) === consumeCountBefore + 1, `quota counter genuinely incremented by exactly 1 on a real finalized success, and was NOT refunded (before=${consumeCountBefore}, after=${consumeAfter?.daily_resume_analyses_count})`);

    const { data: consumeEvents } = await admin.from('resume_quota_events').select('event_type').eq('analysis_id', claim.id);
    assert((consumeEvents ?? []).every((e) => e.event_type !== 'refunded'), 'no refund event exists for this successfully-finalized attempt');
  } finally {
    console.log('\nCleanup…');
    const cleanupFailures: string[] = [];
    for (const id of cleanupUserIds) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(id);
      if (deleteError) {
        cleanupFailures.push(`${id}: auth deletion failed (${deleteError.message})`);
        continue;
      }
      const { data: remainingUser, error: verifyError } = await admin.auth.admin.getUserById(id);
      if (verifyError && !/not found|user not found/i.test(verifyError.message)) {
        cleanupFailures.push(`${id}: could not verify deletion (${verifyError.message})`);
      } else if (remainingUser?.user) {
        cleanupFailures.push(`${id}: user still exists after deletion`);
      }
    }
    if (cleanupFailures.length) {
      console.error('CLEANUP FAILURE — manual isolated-project inspection required:\n' + cleanupFailures.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Cleanup verified for ${cleanupUserIds.length} test user(s); dependent rows rely on database FK cascades.`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
