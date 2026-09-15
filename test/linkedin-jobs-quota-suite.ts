/**
 * LinkedIn Job Finder — LIVE verification of reserve_linkedin_search() /
 * rollback_linkedin_search_reservation() (migration 027, just applied) —
 * the Step-2-deferred "Pro/Free search-limit enforcement" (point 6) and
 * the quota-exhaustion half of point 7. Real Postgres RPCs, real test
 * users, real row-locked reservations — no mocks.
 *
 * Run: npx tsx test/linkedin-jobs-quota-suite.ts
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { newVerifiedSession, adminClient, hasRequiredEnv } from './helpers/verified-session';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

async function run() {
  console.log('==============================================================================');
  console.log('LINKEDIN JOB FINDER — LIVE quota guardrail (migration 027)');
  console.log('==============================================================================\n');

  if (!hasRequiredEnv()) {
    console.log('Missing required env vars. Skipping.');
    return;
  }
  const admin = adminClient();

  console.log('1. RPC existence probe (28000 unauthenticated = exists; 42883 = not applied)');
  {
    const anon = (await import('./helpers/verified-session')).anonKeyClient();
    const { error } = await anon.rpc('reserve_linkedin_search');
    assert(!!error, 'RPC call without a session returns an error (expected)');
    // Two valid "it exists" signals, both proving the function is really
    // there: 28000 (the function body's own auth.uid() IS NULL check) or
    // 42501 (REVOKE ALL FROM PUBLIC, anon blocking the call before the
    // body even runs — the stricter, correctly-locked-down path, mirroring
    // reserve_proposal()'s identical grants). 42883 (function does not
    // exist) is the only code that would mean "not applied".
    assert(
      (error as any)?.code === '28000' ||
      (error as any)?.code === '42501' ||
      /unauthenticated|permission denied/i.test(error?.message || ''),
      `error proves reserve_linkedin_search() EXISTS and is correctly access-controlled (got code=${(error as any)?.code}, message="${error?.message}")`
    );
    assert(
      (error as any)?.code !== '42883',
      'NOT the "function does not exist" error — migration 027 is genuinely applied'
    );
  }

  console.log('\n2. Free-tier: exactly 3 allowed, 4th denied, atomic and row-locked');
  {
    const session = await newVerifiedSession();
    try {
      const { data: profBefore } = await admin.from('profiles').select('plan_tier, daily_linkedin_searches_count').eq('id', session.userId).single();
      assert(profBefore?.plan_tier === 'free', `new test user defaults to plan_tier='free' (got '${profBefore?.plan_tier}')`);

      const results: any[] = [];
      for (let i = 0; i < 4; i++) {
        const { data, error } = await session.client.rpc('reserve_linkedin_search');
        assert(!error, `call ${i + 1}/4 completed without an RPC error`);
        results.push(data);
      }

      assert(results[0]?.allowed === true, 'call 1: allowed');
      assert(results[1]?.allowed === true, 'call 2: allowed');
      assert(results[2]?.allowed === true, 'call 3: allowed');
      assert(results[3]?.allowed === false, `call 4: DENIED — Free limit of 3/day enforced (got allowed=${results[3]?.allowed})`);
      assert(results[3]?.reason === 'linkedin_search', "denial reason correctly tagged 'linkedin_search'");
      assert(results[2]?.remaining === 0, `call 3 correctly reports 0 remaining (got ${results[2]?.remaining})`);

      const { data: profAfter } = await admin.from('profiles').select('daily_linkedin_searches_count').eq('id', session.userId).single();
      assert(profAfter?.daily_linkedin_searches_count === 3, `DB counter correctly stopped at 3 (the 4th, denied call did not increment it — got ${profAfter?.daily_linkedin_searches_count})`);
    } finally {
      await admin.auth.admin.deleteUser(session.userId);
    }
  }

  console.log('\n3. rollback_linkedin_search_reservation() correctly gives a unit back');
  {
    const session = await newVerifiedSession();
    try {
      await session.client.rpc('reserve_linkedin_search');
      await session.client.rpc('reserve_linkedin_search');
      const { data: rolled } = await session.client.rpc('rollback_linkedin_search_reservation');
      assert(rolled?.success === true, 'rollback RPC reports success');

      const { data: profAfterRollback } = await admin.from('profiles').select('daily_linkedin_searches_count').eq('id', session.userId).single();
      assert(profAfterRollback?.daily_linkedin_searches_count === 1, `count correctly decremented by exactly 1 after rollback (got ${profAfterRollback?.daily_linkedin_searches_count})`);

      // The rolled-back unit is usable again — 2 more reservations should
      // succeed (count 1 -> 2 -> 3), proving rollback genuinely restores
      // capacity rather than just cosmetically changing a number.
      const r3 = await session.client.rpc('reserve_linkedin_search');
      const r4 = await session.client.rpc('reserve_linkedin_search');
      assert(r3.data?.allowed === true && r4.data?.allowed === true, 'the rolled-back unit is genuinely usable again (2 more reservations succeed)');
    } finally {
      await admin.auth.admin.deleteUser(session.userId);
    }
  }

  console.log('\n4. Pro-tier: unlimited, never denied, remaining always null');
  {
    const session = await newVerifiedSession();
    try {
      const { error: upErr } = await admin.from('profiles').update({ plan_tier: 'pro' }).eq('id', session.userId);
      if (upErr) throw new Error(`Could not set plan_tier=pro: ${upErr.message}`);

      let allAllowed = true;
      let anyNonNullRemaining = false;
      for (let i = 0; i < 6; i++) {
        const { data } = await session.client.rpc('reserve_linkedin_search');
        if (data?.allowed !== true) allAllowed = false;
        if (data?.remaining !== null) anyNonNullRemaining = true;
      }
      assert(allAllowed, 'a Pro user is allowed 6/6 consecutive searches — well past the Free 3/day cap');
      assert(!anyNonNullRemaining, 'a Pro user always gets remaining=null (unlimited), never a countdown');
    } finally {
      await admin.auth.admin.deleteUser(session.userId);
    }
  }

  console.log('\n5. UTC daily reset boundary — usage_date advancing resets the counter (mirrors the existing swipe/proposal reset)');
  {
    const session = await newVerifiedSession();
    try {
      await session.client.rpc('reserve_linkedin_search');
      await session.client.rpc('reserve_linkedin_search');
      await session.client.rpc('reserve_linkedin_search');
      const { data: denied } = await session.client.rpc('reserve_linkedin_search');
      assert(denied?.allowed === false, 'confirmed exhausted before simulating a day rollover');

      // Simulate "yesterday" by moving usage_date back, exactly as
      // utc-reset.sql's own existing test technique does for swipes/proposals.
      await admin.from('profiles').update({ usage_date: '2020-01-01' }).eq('id', session.userId);

      const { data: afterReset } = await session.client.rpc('reserve_linkedin_search');
      assert(afterReset?.allowed === true, 'a new UTC day resets the LinkedIn search counter, exactly like swipes/proposals');
    } finally {
      await admin.auth.admin.deleteUser(session.userId);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running linkedin-jobs-quota-suite:', e); process.exit(1); });
