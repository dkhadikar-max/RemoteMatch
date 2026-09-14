/**
 * AI Phase 1B — OpenAI spend ledger RPCs
 * (docs/ai-phase1b-implementation-plan.md §2, §7; supabase/migrations/024_ai_spend_ledger.sql)
 * ==============================================================================
 * Exercises the REAL, unmodified reserve_openai_spend()/consume_openai_
 * spend()/refund_openai_spend() RPCs directly via the real service-role
 * client — not a mock of the RPC logic. Uses a uniquely-prefixed synthetic
 * `model` value for every test row so this suite never touches the real
 * `gpt-5-mini` / production-feature production ledger rows, same
 * synthetic-fixture discipline as ai-quota-ledger-suite.ts (Phase 1A).
 *
 * No real OpenAI API call is made anywhere in this suite — every test
 * exercises the ledger (pure Postgres) directly, consistent with the
 * locked decision that the first real paid OpenAI call is its own,
 * separate authorization (docs/ai-phase1b-implementation-plan.md §7.3).
 *
 * REQUIRES: supabase/migrations/024_ai_spend_ledger.sql applied.
 *
 * Run: npx tsx test/ai-spend-ledger-suite.ts
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
    await admin.from('ai_spend_ledger').delete().eq('provider', 'openai').eq('model', model);
  }
}

async function main() {
  if (!hasRequiredEnv()) {
    console.error('Missing required env vars. Skipping.');
    process.exit(1);
  }

  const admin = adminClient();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { error: probeError } = await admin.from('ai_spend_ledger').select('provider').limit(1);
  if (probeError) {
    console.error('supabase/migrations/024_ai_spend_ledger.sql does not appear to be applied yet. Error:', probeError.message);
    process.exit(1);
  }

  console.log('\n=== Test 1: reserve/consume — the safety invariant (consume, never refund, on ANY provider response) ===');
  {
    const model = `test-model-consume-${runId}`;
    const { data: reserve1 } = await admin.rpc('reserve_openai_spend', {
      p_model: model, p_feature: FEATURE, p_reserved_cost_usd: 0.01, p_daily_cap_usd: 5, p_monthly_cap_usd: 50,
    });
    assert(reserve1?.allowed === true, 'reservation 1 allowed under the caps');

    // Reconciled real cost (0.0075) differs from the original reservation
    // (0.01) — proves consume uses the ACTUAL cost for estimated_cost_usd
    // while releasing the ORIGINAL reservation amount from reserved_cost_usd.
    await admin.rpc('consume_openai_spend', {
      p_model: model, p_feature: FEATURE, p_usage_period: TODAY,
      p_actual_cost_usd: 0.0075, p_reserved_cost_usd: 0.01, p_tokens_used: 500,
    });

    const { data: row } = await admin
      .from('ai_spend_ledger')
      .select('estimated_cost_usd, reserved_cost_usd, tokens_used')
      .eq('provider', 'openai').eq('model', model).eq('usage_period', TODAY).eq('feature', FEATURE)
      .maybeSingle();
    assert(Number(row?.estimated_cost_usd) === 0.0075, `estimated_cost_usd reconciled to the REAL cost 0.0075 (got ${row?.estimated_cost_usd})`);
    assert(Number(row?.reserved_cost_usd) === 0, `reserved_cost_usd released back to 0 after consume (got ${row?.reserved_cost_usd})`);
    assert(Number(row?.tokens_used) === 500, `tokens_used recorded (got ${row?.tokens_used})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 2: reserve/refund — the ONLY path that returns budget, for a pre-flight-only failure ===');
  {
    const model = `test-model-refund-${runId}`;
    await admin.rpc('reserve_openai_spend', {
      p_model: model, p_feature: FEATURE, p_reserved_cost_usd: 0.02, p_daily_cap_usd: 5, p_monthly_cap_usd: 50,
    });
    await admin.rpc('refund_openai_spend', {
      p_model: model, p_feature: FEATURE, p_usage_period: TODAY, p_reserved_cost_usd: 0.02,
    });

    const { data: row } = await admin
      .from('ai_spend_ledger')
      .select('estimated_cost_usd, reserved_cost_usd')
      .eq('provider', 'openai').eq('model', model).eq('usage_period', TODAY).eq('feature', FEATURE)
      .maybeSingle();
    assert(Number(row?.estimated_cost_usd) === 0, `estimated_cost_usd stays 0 after refund — refund NEVER touches it (got ${row?.estimated_cost_usd})`);
    assert(Number(row?.reserved_cost_usd) === 0, `reserved_cost_usd released back to 0 after refund (got ${row?.reserved_cost_usd})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 3: daily cap is enforced — reservation denied once it would exceed the cap ===');
  {
    const model = `test-model-dailycap-${runId}`;
    const dailyCap = 0.05;

    const r1 = await admin.rpc('reserve_openai_spend', {
      p_model: model, p_feature: FEATURE, p_reserved_cost_usd: 0.03, p_daily_cap_usd: dailyCap, p_monthly_cap_usd: 50,
    });
    assert(r1.data?.allowed === true, 'first reservation (0.03) allowed under a 0.05 daily cap');

    const r2 = await admin.rpc('reserve_openai_spend', {
      p_model: model, p_feature: FEATURE, p_reserved_cost_usd: 0.03, p_daily_cap_usd: dailyCap, p_monthly_cap_usd: 50,
    });
    assert(r2.data?.allowed === false, 'second reservation (0.03, total would be 0.06 > 0.05 cap) is denied');
    assert(r2.data?.reason === 'daily_cap_exceeded', `denial reason is 'daily_cap_exceeded' (got ${r2.data?.reason})`);

    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 4: monthly cap is enforced across multiple days for the same model/feature ===');
  {
    const model = `test-model-monthlycap-${runId}`;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    const day2 = new Date(monthStart);
    day2.setUTCDate(2);
    const day2Str = day2.toISOString().slice(0, 10);

    // Seed a prior day this month with spend already at $4.00.
    await admin.from('ai_spend_ledger').insert({
      provider: 'openai', model, usage_period: day2Str, feature: FEATURE,
      estimated_cost_usd: 4.0, reserved_cost_usd: 0, tokens_used: 100000,
    });

    // Today's reservation of $1.50 would bring the MONTHLY total to $5.50,
    // exceeding a $5 monthly cap — even though today's own daily cap ($10)
    // has plenty of room.
    const r = await admin.rpc('reserve_openai_spend', {
      p_model: model, p_feature: FEATURE, p_reserved_cost_usd: 1.5, p_daily_cap_usd: 10, p_monthly_cap_usd: 5,
    });
    assert(r.data?.allowed === false, 'reservation denied when it would push the MONTHLY total over the monthly cap, even though the daily cap alone has room');
    assert(r.data?.reason === 'monthly_cap_exceeded', `denial reason is 'monthly_cap_exceeded' (got ${r.data?.reason})`);

    await admin.from('ai_spend_ledger').delete().eq('provider', 'openai').eq('model', model).eq('usage_period', day2Str);
    await cleanup(admin, [model]);
  }

  console.log('\n=== Test 5: reservation-estimate conservatism — worst-case token count never exceeds what was reserved ===');
  {
    // estimateReservationCostUsd's formula (spend-ledger.ts) is
    // (promptLength/3 * inputPrice) + (maxTokens * outputPrice) — the
    // worst-case actual cost (prompt fully counted + maxTokens fully
    // consumed as output) must never exceed this reservation, proving the
    // conservative-overestimate property holds for realistic inputs.
    const { estimateReservationCostUsd } = await import('../src/lib/ai/spend-ledger');
    const { OPENAI_INPUT_PRICE_PER_TOKEN, OPENAI_OUTPUT_PRICE_PER_TOKEN } = await import('../src/lib/ai/openai-config');

    const promptText = 'A realistic-length prompt. '.repeat(50); // ~1400 chars
    const maxTokens = 2000;
    const reserved = estimateReservationCostUsd(promptText, maxTokens);

    // Worst-case REAL cost if the actual tokenizer used the conservative
    // ~4 chars/token average (more tokens = more accurate than our 3
    // chars/token estimate, i.e. our estimate should never UNDER-count
    // prompt tokens for real English text) plus the full output budget.
    const realisticPromptTokens = Math.ceil(promptText.length / 4);
    const worstCaseRealCost = realisticPromptTokens * OPENAI_INPUT_PRICE_PER_TOKEN + maxTokens * OPENAI_OUTPUT_PRICE_PER_TOKEN;

    assert(reserved >= worstCaseRealCost, `reservation (${reserved}) is >= a realistic worst-case actual cost (${worstCaseRealCost}) — never under-reserves`);
  }

  console.log('\n=== Test 6: consumeOpenAiSpend() returns the RECONCILED actual cost, not the reservation estimate (fixed 2026-09-14) ===');
  {
    // Real finding from Phase 1B live verification: ai_call_events was
    // recording reservedCostUsd instead of the reconciled actual cost,
    // even though ai_spend_ledger itself correctly reconciled — a real
    // observability inconsistency. This asserts the TS wrapper's return
    // value (what materials.ts/resume.ts/resume-intelligence.ts now pass
    // to recordAiCallEvent) is the reconciled figure.
    const { consumeOpenAiSpend } = await import('../src/lib/ai/spend-ledger');
    const { OPENAI_INPUT_PRICE_PER_TOKEN, OPENAI_OUTPUT_PRICE_PER_TOKEN, OPENAI_MODEL_ID } = await import('../src/lib/ai/openai-config');

    // Reserve a deliberately LARGE estimate (as if maxTokens was generous),
    // then consume with much SMALLER real usage — the classic case where
    // reservedCostUsd and the real reconciled cost genuinely differ, which
    // is exactly the scenario the original bug got wrong. consumeOpenAiSpend()
    // always targets OPENAI_MODEL_ID internally (not test-injectable), so
    // this uses the real model id with a synthetic `feature` to stay
    // isolated from real production o3_o4_materials/resume_* rows.
    const reservedCostUsd = 0.02;
    const realPromptTokens = 200;
    const realCompletionTokens = 100;
    const expectedActualCost = realPromptTokens * OPENAI_INPUT_PRICE_PER_TOKEN + realCompletionTokens * OPENAI_OUTPUT_PRICE_PER_TOKEN;

    const result = await consumeOpenAiSpend(FEATURE, TODAY, reservedCostUsd, realPromptTokens, realCompletionTokens);

    assert(
      Math.abs(result.actualCostUsd - expectedActualCost) < 1e-9,
      `consumeOpenAiSpend() returns the reconciled actual cost (${expectedActualCost}), not the reservation estimate (${reservedCostUsd}) — got ${result.actualCostUsd}`
    );
    assert(
      result.actualCostUsd !== reservedCostUsd,
      'sanity: the reconciled cost and the reservation estimate are genuinely different values in this scenario, proving this test would have caught the original bug'
    );
    assert(
      result.tokensUsed === realPromptTokens + realCompletionTokens,
      `consumeOpenAiSpend() returns the real total tokens used (${realPromptTokens + realCompletionTokens}), got ${result.tokensUsed}`
    );

    // Scoped cleanup by (real model, TEST feature) only — NEVER delete by
    // model alone here, since OPENAI_MODEL_ID is the real production model
    // and other features' real rows (e.g. o3_o4_materials, from actual live
    // verification calls) must not be touched.
    await admin.from('ai_spend_ledger').delete()
      .eq('provider', 'openai').eq('model', OPENAI_MODEL_ID).eq('usage_period', TODAY).eq('feature', FEATURE);
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
