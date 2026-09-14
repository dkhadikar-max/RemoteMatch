/**
 * AI Phase 1A/1B — fail-closed regression coverage for a synchronous
 * getSupabaseAdminClient() throw
 * (docs/ai-phase1b-implementation-plan.md; real finding from Phase 1B live
 * verification, 2026-09-14).
 * ==============================================================================
 * Deliberately reproduces the REAL crash this hardening fix addresses,
 * rather than mocking it: getSupabaseAdminClient() (src/lib/supabase/
 * admin.ts) constructs a real @supabase/supabase-js client, whose Realtime
 * sub-client requires a WebSocket constructor on Node < 22 — present via
 * Next.js's own server runtime in production (proven by Phase 1A's live
 * success), ABSENT in a bare Node/tsx process with no polyfill. This file
 * intentionally does NOT set `global.WebSocket` and does NOT import `ws`
 * anywhere — the opposite of every other suite in this repo — specifically
 * to trigger that real, synchronous throw and prove reserveGeminiRequest()/
 * reserveOpenAiSpend() catch it and fail closed (`{allowed: false}`) rather
 * than letting it propagate into their callers (career-page-extraction.ts /
 * materials.ts / resume.ts / resume-intelligence.ts).
 *
 * MUST run in its own process, never combined with another suite in the
 * same Node invocation — admin.ts caches its client in a module-level
 * singleton, so a client already constructed successfully earlier in the
 * same process (by a suite that DID polyfill WebSocket) would be reused
 * here instead of re-attempting construction, silently defeating this test.
 *
 * REQUIRES: real NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env
 * vars set (so isSupabaseAdminConfigured is true and construction is
 * actually attempted) — same env this project's other real-infra suites need.
 *
 * Run: npx tsx test/ai-ledger-failsafe-suite.ts
 */

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

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required env vars. Skipping.');
    process.exit(1);
  }
  if ((global as any).WebSocket) {
    console.error('global.WebSocket is unexpectedly already set in this process — this suite cannot validate the real failure mode. Run it alone, not combined with another suite.');
    process.exit(1);
  }

  console.log('\n=== Confirming the real crash still reproduces without hardening (sanity check on the premise) ===');
  {
    const { getSupabaseAdminClient } = await import('../src/lib/supabase/admin');
    let threw = false;
    try {
      getSupabaseAdminClient();
    } catch (err) {
      threw = true;
      console.log(`  (confirmed real throw: ${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }
    assert(threw, 'getSupabaseAdminClient() genuinely throws synchronously in this bare-Node, no-WebSocket-polyfill environment — the real condition this hardening fix exists for');
  }

  console.log('\n=== reserveGeminiRequest() fails closed instead of throwing ===');
  {
    const { reserveGeminiRequest } = await import('../src/lib/ai/quota-ledger');
    let result;
    let threw = false;
    try {
      result = await reserveGeminiRequest('00000000-0000-0000-0000-000000000000');
    } catch {
      threw = true;
    }
    assert(!threw, 'reserveGeminiRequest() does NOT let the synchronous throw escape');
    assert(result?.allowed === false, `reserveGeminiRequest() fails closed (allowed: false) instead (got ${JSON.stringify(result)})`);
  }

  console.log('\n=== reserveOpenAiSpend() fails closed instead of throwing ===');
  {
    const { reserveOpenAiSpend } = await import('../src/lib/ai/spend-ledger');
    let result;
    let threw = false;
    try {
      result = await reserveOpenAiSpend('test_feature', 'a test prompt', 1000);
    } catch {
      threw = true;
    }
    assert(!threw, 'reserveOpenAiSpend() does NOT let the synchronous throw escape');
    assert(result?.allowed === false, `reserveOpenAiSpend() fails closed (allowed: false) instead (got ${JSON.stringify(result)})`);
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
