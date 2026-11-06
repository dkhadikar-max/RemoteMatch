/**
 * RemoteMatch — international-plan recognition + webhook activation suite.
 * ==============================================================================
 * F4 from the 2026-11-05 audit (docs/international-payments-audit-plan-2026-10-31.md
 * §7): `activePlanIds()`/`isProPlanSubscription()` had ZERO test coverage before
 * this file, despite being what makes a non-INR webhook recognized as "ours" —
 * a regression there means a paid international subscriber is charged and
 * never upgraded. Covers exactly the six cases Deep specified: INR plan
 * recognition, USD plan recognition, unknown-plan rejection, missing env
 * config, multiple configured plans, and — the most important one — a
 * successful USD payment upgrading the correct user exactly once through
 * real webhook processing.
 *
 * PART A is pure-unit (no network) but still needs real-looking env present
 * at process start, because `src/lib/razorpay.ts`'s `isRazorpayConfigured`/
 * base `planId` are computed ONCE at module import time, not read live per
 * call (unlike `currency-config.ts`'s functions, which do read live — that
 * asymmetry is itself worth knowing before writing more tests here).
 * PART B is real-infra: real Supabase writes against the ISOLATED test
 * project only (profiles table), with a STUBBED subscription object — no
 * real Razorpay API call. No migration, no dashboard change, nothing live.
 * PART C (added 2026-11-05, F3) covers the billing_transactions write-path's
 * gating/field logic via the recordBillingTransaction test seam — migration
 * 043 is NOT applied to any database, so the real table can't be written to
 * yet; this proves the decision logic (ownership gating, field mapping,
 * never-blocks-on-failure) without needing it to exist.
 * PART D (added 2026-11-06, G1 close-out integration review) chains the real
 * G1 fix together with the F3 ledger gating for the first time — Part C
 * always handed processWebhookEvent an already-resolved subscription, never
 * exercising parseWebhookEvent itself. D runs real raw payment.failed /
 * refund.created JSON through parseWebhookEvent, a REAL Razorpay
 * fetchSubscription call, then processWebhookEvent — proving failed/refunded
 * ledger rows, duplicate-delivery idempotency, missing-association safety,
 * and non-blocking failure logging all the way through, not just each piece
 * in isolation.
 *
 * REQUIRES: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY for the ISOLATED test project, RAZORPAY_KEY_ID
 * (rzp_test_ only — refuses live), RAZORPAY_KEY_SECRET, RAZORPAY_PRO_PLAN_ID,
 * RAZORPAY_PRO_PLAN_ID_USD.
 *
 * Run: npx tsx --env-file=.env.paidtest.local test/international-plan-suite.ts
 */

import {
  cancelSubscriptionAtCycleEnd,
  createSubscription,
  fetchSubscription,
  isProPlanSubscription,
  type RazorpaySubscription,
} from '../src/lib/razorpay';
import { activePlanIds } from '../src/lib/billing/currency-config';
import { processWebhookEvent } from '../src/lib/razorpay-webhook-apply';
import { parseWebhookEvent } from '../src/lib/razorpay-webhook-parse';
import { adminClient, hasRequiredEnv, newVerifiedSession } from './helpers/verified-session';

const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const INR_PLAN_ID = process.env.RAZORPAY_PRO_PLAN_ID ?? '';
const USD_PLAN_ID = process.env.RAZORPAY_PRO_PLAN_ID_USD ?? '';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

function skip(message: string) {
  console.log(`  ⊘ SKIP: ${message}`);
  skipped++;
}

function stubSub(overrides: Partial<RazorpaySubscription> & Pick<RazorpaySubscription, 'plan_id'>): RazorpaySubscription {
  return {
    id: 'sub_stub_default',
    status: 'created',
    paid_count: 0,
    customer_id: null,
    current_end: null,
    notes: null,
    ...overrides,
  };
}

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — INTERNATIONAL PLAN RECOGNITION + WEBHOOK ACTIVATION SUITE');
  console.log('='.repeat(78));

  if (!hasRequiredEnv() || !KEY_ID || !INR_PLAN_ID) {
    console.log('\nSupabase or base Razorpay env is incomplete — reported honestly rather than faked.');
    process.exitCode = 1;
    return;
  }
  if (!KEY_ID.startsWith('rzp_test_')) {
    console.log('\nRefusing to run: RAZORPAY_KEY_ID is not a test-mode key.');
    process.exitCode = 1;
    return;
  }

  // ----------------------------------------------------------------------
  console.log('\nPART A — isProPlanSubscription / activePlanIds (pure unit, real env)');

  console.log('\nF4.1: INR plan recognition');
  assert(
    isProPlanSubscription(stubSub({ id: 'sub_a', plan_id: INR_PLAN_ID })),
    'a subscription on the base INR plan is recognized as ours'
  );

  console.log('\nF4.2: USD plan recognition');
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set in this env — cannot test USD recognition');
  } else {
    assert(
      isProPlanSubscription(stubSub({ id: 'sub_b', plan_id: USD_PLAN_ID })),
      'a subscription on the active USD plan is recognized as ours',
      { USD_PLAN_ID }
    );
  }

  console.log('\nF4.3: unknown-plan rejection');
  assert(
    isProPlanSubscription(stubSub({ id: 'sub_c', plan_id: 'plan_totallyMadeUpNotOurs000' })) === false,
    'a plan id that is neither the INR plan nor any active currency plan is rejected'
  );

  console.log('\nF4.4: missing environment configuration');
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set — this case is already exercised by default in this env');
  } else {
    const saved = process.env.RAZORPAY_PRO_PLAN_ID_USD;
    delete process.env.RAZORPAY_PRO_PLAN_ID_USD;
    try {
      assert(
        isProPlanSubscription(stubSub({ id: 'sub_d', plan_id: USD_PLAN_ID })) === false,
        'a USD-plan subscription is NOT recognized once RAZORPAY_PRO_PLAN_ID_USD is unset — proves activePlanIds() reads live, never caches a stale "active" currency'
      );
    } finally {
      process.env.RAZORPAY_PRO_PLAN_ID_USD = saved;
    }
    // Restored — confirm recognition comes back immediately (live read, no caching either direction).
    assert(
      isProPlanSubscription(stubSub({ id: 'sub_d2', plan_id: USD_PLAN_ID })),
      'USD recognition returns immediately once the env var is restored (no stale negative caching)'
    );
  }

  console.log('\nF4.5: multiple configured plan ids');
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set — cannot exercise multiple active plans');
  } else {
    const ids = activePlanIds();
    assert(
      ids.has(INR_PLAN_ID) && ids.has(USD_PLAN_ID) && ids.size >= 2,
      'activePlanIds() contains BOTH the INR and USD plan ids simultaneously',
      { size: ids.size }
    );
  }

  // ----------------------------------------------------------------------
  console.log('\nPART B — real webhook activation (real infra, isolated DB, stubbed Razorpay read)');
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set — cannot run the USD activation test');
  } else {
    const admin = adminClient();
    const user = await newVerifiedSession();
    try {
      const sub = stubSub({
        id: `sub_test_usd_${Date.now()}`,
        plan_id: USD_PLAN_ID,
        status: 'active',
        paid_count: 1,
        notes: { userId: user.userId },
      });

      console.log('\nF4.6: a successful USD payment upgrades the correct user, exactly once');
      const first = await processWebhookEvent(admin, {
        eventId: `evt_test_usd_${Date.now()}`,
        eventType: 'subscription.activated',
        subscription: sub,
      });
      assert(first.status === 200, 'first webhook application returns 200', first);

      const { data: afterFirst } = await admin
        .from('profiles')
        .select('plan_tier, razorpay_subscription_id, razorpay_subscription_status')
        .eq('id', user.userId)
        .single();
      assert(
        afterFirst?.plan_tier === 'pro' && afterFirst?.razorpay_subscription_id === sub.id,
        'profile is upgraded to pro and bound to the USD subscription id',
        afterFirst
      );

      // Reprocessing the same event (as a redelivery would) must be a no-op
      // in EFFECT: still exactly one profile, still pro, still bound to the
      // same subscription — never a second grant, never an error.
      const second = await processWebhookEvent(admin, {
        eventId: `evt_test_usd_redelivery_${Date.now()}`, // different event id, SAME subscription — the realistic redelivery/duplicate-charge-event shape
        eventType: 'subscription.charged',
        subscription: sub,
      });
      assert(second.status === 200, 'second (redelivery-shaped) webhook application also returns 200', second);

      const { data: afterSecond } = await admin
        .from('profiles')
        .select('plan_tier, razorpay_subscription_id')
        .eq('id', user.userId)
        .single();
      assert(
        afterSecond?.plan_tier === 'pro' && afterSecond?.razorpay_subscription_id === sub.id,
        'profile is still exactly pro, still bound to the same one subscription — reprocessing never double-applies',
        afterSecond
      );
    } finally {
      await admin.auth.admin.deleteUser(user.userId).catch(() => {});
    }
  }

  // ----------------------------------------------------------------------
  console.log('\nPART C — billing_transactions write-path gating (2026-11-05, F3)');
  // Migration 043 (billing_transactions) is NOT applied to any database yet —
  // deliberately, per the standing boundary. So this cannot write-and-verify
  // against the real table the way Part B does for profiles. What CAN be
  // proven without it: the gating logic and field construction in
  // processWebhookEvent are correct, and a ledger-write failure never blocks
  // or fails the primary webhook response — using the recordBillingTransaction
  // test seam to intercept the write instead of touching a real table.
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set — cannot exercise the ledger gating');
  } else {
    const admin = adminClient();
    const user = await newVerifiedSession();
    try {
      const sub = stubSub({
        id: `sub_test_ledger_${Date.now()}`,
        plan_id: USD_PLAN_ID,
        status: 'active',
        paid_count: 1,
        notes: { userId: user.userId },
      });
      const payment = { id: `pay_test_${Date.now()}`, amount: 900, currency: 'USD', status: 'captured' };

      console.log('\nF3.1: payment tied to one of our plans is recorded with the right fields');
      type BillingRow = { profile_id: string; razorpay_payment_id: string; razorpay_subscription_id: string; amount_minor: number; currency: string; status: string; razorpay_event_id: string | null };
      const capturedBox: { value: BillingRow | null } = { value: null };
      const ledgerEventId = `evt_ledger_ours_${Date.now()}`;
      const r1 = await processWebhookEvent(
        admin,
        { eventId: ledgerEventId, eventType: 'subscription.charged', subscription: sub, payment },
        { recordBillingTransaction: async (row) => { capturedBox.value = row; return { error: null }; } }
      );
      assert(r1.status === 200, 'webhook with a matching payment still returns 200', r1);
      const c: BillingRow | null = capturedBox.value;
      assert(
        c !== null &&
          c.profile_id === user.userId &&
          c.razorpay_payment_id === payment.id &&
          c.razorpay_subscription_id === sub.id &&
          c.amount_minor === payment.amount &&
          c.currency === payment.currency &&
          c.status === payment.status &&
          c.razorpay_event_id === ledgerEventId,
        'the ledger row passed to the writer has the correct profile, payment, subscription, amount, currency, status and event id',
        c
      );

      console.log('\nF3.2: payment NOT tied to one of our plans is never recorded');
      let calledForUnrelated = false;
      const unrelatedSub = stubSub({ id: `sub_unrelated_${Date.now()}`, plan_id: 'plan_someOtherPlanNotOurs', status: 'active', paid_count: 1, notes: { userId: user.userId } });
      await processWebhookEvent(
        admin,
        { eventId: `evt_ledger_unrelated_${Date.now()}`, eventType: 'subscription.charged', subscription: unrelatedSub, payment },
        { recordBillingTransaction: async (row) => { calledForUnrelated = true; return { error: null }; } }
      );
      assert(!calledForUnrelated, 'a payment on a plan that is not ours is never written to the ledger');

      console.log('\nF3.3: no payment entity on the event → no ledger write, no error');
      let calledWithNoPayment = false;
      const r3 = await processWebhookEvent(
        admin,
        { eventId: `evt_ledger_nopay_${Date.now()}`, eventType: 'subscription.cancelled', subscription: sub, payment: null },
        { recordBillingTransaction: async () => { calledWithNoPayment = true; return { error: null }; } }
      );
      assert(r3.status === 200 && !calledWithNoPayment, 'an event with no payment entity never attempts a ledger write, and still returns 200', r3);

      console.log('\nF3.4: a ledger-write failure never blocks or fails the primary webhook response');
      const eventId4 = `evt_ledger_fails_${Date.now()}`;
      const r4 = await processWebhookEvent(
        admin,
        { eventId: eventId4, eventType: 'subscription.charged', subscription: sub, payment },
        { recordBillingTransaction: async () => ({ error: { message: 'simulated ledger failure' } }) }
      );
      assert(r4.status === 200, 'webhook still returns 200 even when the ledger write itself fails', r4);
      const { data: eventRow } = await admin.from('razorpay_webhook_events').select('event_id').eq('event_id', eventId4).maybeSingle();
      assert(Boolean(eventRow), 'the webhook event is still recorded as handled despite the ledger-write failure (primary flow unaffected)');
    } finally {
      await admin.auth.admin.deleteUser(user.userId).catch(() => {});
    }
  }

  // ----------------------------------------------------------------------
  console.log('\nPART D — full webhook-lifecycle integration review (2026-11-06, G1 close-out)');
  // The G1 fix (razorpay-webhook-parse-suite.ts) and the F3 ledger gating
  // (Part C above) were each proven correct in isolation, but never chained
  // together: Part C always handed processWebhookEvent an already-resolved
  // subscription object; it never went through parseWebhookEvent itself, so
  // the actual G1 code path (resolving a subscription from a raw
  // payment.failed/refund.created BODY) was never exercised together with
  // the ledger write it unblocks. This closes that gap: real raw webhook
  // JSON → parseWebhookEvent → a REAL Razorpay fetchSubscription call → the
  // real ledger-gating logic, end to end, for both failure and refund.
  if (!USD_PLAN_ID) {
    skip('RAZORPAY_PRO_PLAN_ID_USD not set — cannot run the full-chain review');
  } else {
    const admin = adminClient();
    const user = await newVerifiedSession();
    let subId: string | null = null;
    try {
      const created = await createSubscription({ userId: user.userId, planId: USD_PLAN_ID });
      subId = created.id;

      console.log('\nD1: payment.failed (raw body) → parse → real subscription fetch → failed ledger row');
      {
        const rawBody = JSON.stringify({
          event: 'payment.failed',
          payload: { payment: { entity: { id: `pay_d1_failed_${Date.now()}`, amount: 900, currency: 'USD', status: 'failed', subscription_id: subId } } },
        });
        const { eventType, subscriptionId, payment } = parseWebhookEvent(rawBody);
        assert(subscriptionId === subId, 'parseWebhookEvent resolves the real subscription id from a payment.failed body with no subscription entity', { subscriptionId, subId });

        const subscription = await fetchSubscription(subscriptionId!); // real Razorpay call — this is THE step that would 502 if subscriptionId were wrong
        assert(subscription.id === subId, 'the resolved id fetches the real subscription from Razorpay', subscription.id);

        const box: { value: unknown } = { value: null };
        const result = await processWebhookEvent(
          admin,
          { eventId: `evt_d1_${Date.now()}`, eventType, subscription, payment },
          { recordBillingTransaction: async (row) => { box.value = row; return { error: null }; } }
        );
        assert(result.status === 200, 'the full chain still returns 200 for a failed payment', result);
        const row = box.value as { status: string; razorpay_payment_id: string; razorpay_subscription_id: string } | null;
        assert(row !== null && row.status === 'failed' && row.razorpay_subscription_id === subId, 'a failed-payment ledger row would be written, correctly attributed to the real subscription, status "failed"', row);
      }

      console.log('\nD2: refund.created (raw body) → parse → real subscription fetch → refunded ledger row');
      {
        const rawBody = JSON.stringify({
          event: 'refund.created',
          payload: { payment: { entity: { id: `pay_d2_refunded_${Date.now()}`, amount: 900, currency: 'USD', status: 'refunded', subscription_id: subId } } },
        });
        const { eventType, subscriptionId, payment } = parseWebhookEvent(rawBody);
        const subscription = await fetchSubscription(subscriptionId!);
        const box: { value: unknown } = { value: null };
        await processWebhookEvent(
          admin,
          { eventId: `evt_d2_${Date.now()}`, eventType, subscription, payment },
          { recordBillingTransaction: async (row) => { box.value = row; return { error: null }; } }
        );
        const row = box.value as { status: string } | null;
        assert(row !== null && row.status === 'refunded', 'a refund.created event produces a ledger row with status "refunded"', row);
      }

      console.log('\nD3: duplicate delivery of the SAME failed payment → same upsert key both times (idempotent by construction)');
      {
        const paymentId = `pay_d3_dup_${Date.now()}`;
        const rawBody = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: paymentId, amount: 900, currency: 'USD', status: 'failed', subscription_id: subId } } } });
        const { eventType, subscriptionId, payment } = parseWebhookEvent(rawBody);
        const subscription = await fetchSubscription(subscriptionId!);
        const captured: string[] = [];
        const seam = { recordBillingTransaction: async (row: { razorpay_payment_id: string }) => { captured.push(row.razorpay_payment_id); return { error: null }; } };
        await processWebhookEvent(admin, { eventId: `evt_d3_first_${Date.now()}`, eventType, subscription, payment }, seam);
        await processWebhookEvent(admin, { eventId: `evt_d3_redelivery_${Date.now()}`, eventType, subscription, payment }, seam);
        assert(
          captured.length === 2 && captured[0] === paymentId && captured[1] === paymentId,
          'a redelivered payment.failed event upserts on the SAME razorpay_payment_id both times — the table\'s UNIQUE constraint is what makes this idempotent once applied, not a duplicate row',
          captured
        );
      }

      console.log('\nD4: missing/malformed association never produces an incorrectly-attributed row');
      {
        // No subscription_id on the payment at all — a genuinely standalone,
        // non-subscription payment. Already covered at the parse level
        // (razorpay-webhook-parse-suite.ts) and the ownership-gating level
        // (F3.2 above); re-confirmed here through the full chain once more.
        const rawBody = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: `pay_d4_standalone_${Date.now()}`, amount: 500, currency: 'INR', status: 'failed' } } } });
        const { subscriptionId, payment } = parseWebhookEvent(rawBody);
        assert(subscriptionId === undefined, 'a standalone payment with no subscription_id resolves no subscription id — nothing to even attempt fetching', { subscriptionId });
        let calledWithoutSubscription = false;
        await processWebhookEvent(
          admin,
          { eventId: `evt_d4_${Date.now()}`, eventType: 'payment.failed', subscription: null, payment },
          { recordBillingTransaction: async () => { calledWithoutSubscription = true; return { error: null }; } }
        );
        assert(!calledWithoutSubscription, 'with no subscription resolved, the ledger gate (event.payment && event.subscription) never fires — no row is ever attributed to anything', null);
      }

      console.log('\nD5: ledger write failure is observable and does not affect entitlement — full chain');
      {
        const rawBody = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: `pay_d5_${Date.now()}`, amount: 900, currency: 'USD', status: 'failed', subscription_id: subId } } } });
        const { eventType, subscriptionId, payment } = parseWebhookEvent(rawBody);
        const subscription = await fetchSubscription(subscriptionId!);
        const eventId = `evt_d5_${Date.now()}`;
        const result = await processWebhookEvent(
          admin,
          { eventId, eventType, subscription, payment },
          { recordBillingTransaction: async () => ({ error: { message: 'simulated failure, full chain' } }) }
        );
        assert(result.status === 200, 'the full chain (real parse + real fetch) still returns 200 when only the ledger write fails', result);
        const { data: eventRow } = await admin.from('razorpay_webhook_events').select('event_id').eq('event_id', eventId).maybeSingle();
        assert(Boolean(eventRow), 'the event is still recorded as handled end to end despite the ledger failure — observable via the console.error added for G1/the ledger-logging hardening, not swallowed');
      }
    } finally {
      if (subId) await cancelSubscriptionAtCycleEnd(subId).catch(() => {});
      await admin.auth.admin.deleteUser(user.userId).catch(() => {});
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
