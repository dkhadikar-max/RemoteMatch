/**
 * RemoteMatch — subscription-reuse decision: pure-unit suite.
 * ==============================================================================
 * PR #50 review remediation (2026-11-06), requirement #1: an explicitly
 * requested currency must not silently reuse a subscription denominated in
 * another currency. Covers `decideSubscriptionReuse` (src/lib/razorpay.ts) in
 * isolation — no network, no database, no Razorpay calls.
 *
 * Run: npx tsx test/razorpay-subscription-reuse-suite.ts
 */

import { decideSubscriptionReuse } from '../src/lib/razorpay';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — SUBSCRIPTION REUSE DECISION SUITE (pure unit)');
  console.log('='.repeat(78));

  console.log('\nSame-currency subscription reuse (the original, intended case)');
  assert(
    decideSubscriptionReuse({ status: 'created', plan_id: 'plan_usd456' }, 'plan_usd456') === 'reuse_unpaid',
    'an unpaid subscription on the SAME plan the request resolved to is reused'
  );
  assert(
    decideSubscriptionReuse({ status: 'created', plan_id: 'plan_inr123' }, 'plan_inr123') === 'reuse_unpaid',
    'same-currency reuse also holds for the base INR plan'
  );

  console.log('\nCross-currency subscription reuse (2026-11-06 fix, requirement #1)');
  assert(
    decideSubscriptionReuse({ status: 'created', plan_id: 'plan_gbp789' }, 'plan_usd456') === 'replace',
    'an unpaid subscription on a DIFFERENT plan/currency than the one just requested is NOT reused — the request\'s explicit currency choice must not be silently discarded',
    { stored: 'plan_gbp789', requested: 'plan_usd456' }
  );
  assert(
    decideSubscriptionReuse({ status: 'created', plan_id: 'plan_inr123' }, 'plan_usd456') === 'replace',
    'a stale INR subscription does not get reused when the current request resolved to USD'
  );

  console.log('\nLive mandate always blocks a second subscription, regardless of currency');
  for (const status of ['authenticated', 'active', 'pending']) {
    assert(
      decideSubscriptionReuse({ status, plan_id: 'plan_gbp789' }, 'plan_usd456') === 'blocked_live_mandate',
      `a LIVE mandate (status='${status}') blocks creating a second subscription even when the currencies differ — two live mandates would risk a double charge`,
      status
    );
    assert(
      decideSubscriptionReuse({ status, plan_id: 'plan_usd456' }, 'plan_usd456') === 'blocked_live_mandate',
      `a LIVE mandate (status='${status}') also blocks when the currencies happen to match — a second subscription must never be created alongside one that can still charge`,
      status
    );
  }

  console.log('\nEnded subscriptions are replaced regardless of currency');
  for (const status of ['halted', 'cancelled', 'completed', 'expired', 'paused']) {
    assert(
      decideSubscriptionReuse({ status, plan_id: 'plan_usd456' }, 'plan_usd456') === 'replace',
      `a subscription that can no longer charge (status='${status}') is replaced even when the currency matches`,
      status
    );
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
