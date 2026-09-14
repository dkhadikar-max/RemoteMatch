/**
 * AI Phase 1A — Gemini request-count ledger RPCs
 * (docs/ai-phase1-implementation-plan.md §3, §9; supabase/migrations/020_ai_quota_ledger.sql)
 * ==============================================================================
 * Exercises the REAL, unmodified reserve_gemini_request()/consume_gemini_
 * request()/refund_gemini_reservation() RPCs directly via the real
 * service-role client — not a mock of the RPC logic. Uses a uniquely-
 * prefixed synthetic `model` value for every test row so this suite never
 * touches the real `gemini-3.5-flash-lite` / `c5_extraction` production
 * ledger row (same synthetic-fixture discipline as career-page-dedup-
 * suite.ts, for the same reason: a production-data-safety concern this
 * project has already built guards against once this session).
 *
 * REQUIRES: supabase/migrations/020_ai_quota_ledger.sql applied (Deep-
 * dashboard-only DDL gate — Claude has no DDL path). Will report a clear
 * "migration not applied yet" failure rather than a confusing error if run
 * before that.
 *
 * Run: npx tsx test/ai-quota-ledger-suite.ts
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

const FEATURE = 'test_feature';
const TODAY = new Date().toISOString().slice(0, 10);

async function cleanup(admin: ReturnType<typeof adminClient>, models: string[]) {
  for (const model of models) {
    await admin.from('ai_quota_ledger').delete().eq('provider', 'gemini').eq('model', model);
  }
}

async function main() {
  if (!hasRequiredEnv()) {
    console.error('Missing required env vars (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY). Skipping.');
    process.exit(1);
  }

  const admin = adminClient();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Sanity check the migration is actually applied before running real
  // assertions against it — a clear, specific failure instead of a
  // confusing PostgREST "relation does not exist" buried in later output.
  const { error: probeError } = await admin.from('ai_quota_ledger').select('provider').limit(1);
  if (probeError) {
    console.error('supabase/migrations/020_ai_quota_ledger.sql does not appear to be applied yet (Deep-dashboard-only DDL gate). Error:', probeError.message);
    process.exit(1);
  }

  console.log('\n=== Test 1: reserve/consume — the safety invariant (consume, never refund, on ANY provider response) ===');
  {
    const model = `test-model-consume-${runId}`;
    const { data: reserve1 } = await admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: 10 });
    assert(reserve1?.allowed === true, 'reservation 1 allowed under the limit');

    await admin.rpc('consume_gemini_request', { p_model: model, p_feature: FEATURE, p_usage_date: TODAY });

    const { data: row } = await admin
      .from('ai_quota_ledger')
      .select('requests_used, requests_reserved')
      .eq('provider', 'gemini').eq('model', model).eq('usage_date', TODAY).eq('feature', FEATURE)
      .maybeSingle();
    assert(row?.requests_used === 1, `requests_used incremented to 1 after consume (got ${row?.requests_used})`);
    assert(row?.requests_reserved === 0, `requests_reserved decremented to 0 after consume (got ${row?.requests_reserved})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 2: reserve/refund — the ONLY path that returns budget, for a pre-flight-only failure ===');
  {
    const model = `test-model-refund-${runId}`;
    await admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: 10 });
    await admin.rpc('refund_gemini_reservation', { p_model: model, p_feature: FEATURE, p_usage_date: TODAY });

    const { data: row } = await admin
      .from('ai_quota_ledger')
      .select('requests_used, requests_reserved')
      .eq('provider', 'gemini').eq('model', model).eq('usage_date', TODAY).eq('feature', FEATURE)
      .maybeSingle();
    assert(row?.requests_used === 0, `requests_used stays 0 after refund — refund NEVER touches requests_used (got ${row?.requests_used})`);
    assert(row?.requests_reserved === 0, `requests_reserved released back to 0 after refund (got ${row?.requests_reserved})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 3: daily limit is enforced — reservation denied once used+reserved reaches the limit ===');
  {
    const model = `test-model-limit-${runId}`;
    const limit = 3;
    let allowedCount = 0;
    for (let i = 0; i < limit + 2; i++) {
      const { data } = await admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: limit });
      if (data?.allowed) {
        allowedCount++;
        await admin.rpc('consume_gemini_request', { p_model: model, p_feature: FEATURE, p_usage_date: TODAY });
      }
    }
    assert(allowedCount === limit, `exactly ${limit} of ${limit + 2} attempts were allowed (got ${allowedCount})`);

    const { data: deniedAttempt } = await admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: limit });
    assert(deniedAttempt?.allowed === false, 'a further reservation past the limit is denied');
    assert(deniedAttempt?.reason === 'global_quota_exhausted', `denial reason is 'global_quota_exhausted' (got ${deniedAttempt?.reason})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 4: concurrent reservations — row lock prevents over-allocation ===');
  {
    const model = `test-model-race-${runId}`;
    const limit = 1;
    // Fire two reservations concurrently against a limit of 1 — the row
    // lock (FOR UPDATE inside reserve_gemini_request) must serialize these
    // so exactly one succeeds, never both.
    const [r1, r2] = await Promise.all([
      admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: limit }),
      admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: limit }),
    ]);
    const allowedCount = [r1.data?.allowed, r2.data?.allowed].filter(Boolean).length;
    assert(allowedCount === 1, `exactly 1 of 2 concurrent reservations against a limit of 1 succeeded (got ${allowedCount})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 5: lazy UTC-day rollover — a new day gets a fresh row, not a stale one ===');
  {
    const model = `test-model-rollover-${runId}`;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // Seed a maxed-out row for "yesterday" directly.
    await admin.from('ai_quota_ledger').insert({
      provider: 'gemini', model, usage_date: yesterday, feature: FEATURE,
      requests_used: 999, requests_reserved: 0,
    });

    const { data } = await admin.rpc('reserve_gemini_request', { p_model: model, p_feature: FEATURE, p_daily_limit: 10 });
    assert(data?.allowed === true, "today's reservation is allowed despite yesterday's row being maxed out (composite PK gives each UTC day its own fresh row)");

    await admin.from('ai_quota_ledger').delete().eq('provider', 'gemini').eq('model', model).eq('usage_date', yesterday);
    await cleanup(admin, [model]);
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
