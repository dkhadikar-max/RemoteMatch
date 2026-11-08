/**
 * RemoteMatch — refund ledger row construction: pure-unit suite.
 * ==============================================================================
 * PR #50 review remediation, round 3 (2026-11-07), P1 items 1+2: multiple
 * partial refunds on the same payment must be preserved as distinct ledger
 * rows, never overwriting each other or the parent payment's capture row,
 * and a ledger entry must never be fabricated when the payment/subscription
 * association cannot be established.
 *
 * Deliberately pure — no network, no database, no real Razorpay API calls,
 * and NO real Supabase client, and critically NO external env file (never
 * touches the isolated test project, which this round's instructions say
 * must stay untouched pending explicit re-authorization). `isProPlanSubscription`
 * needs `isRazorpayConfigured`/`activePlanIds()` to recognize a plan id as
 * "ours," and `isRazorpayConfigured` is computed ONCE at razorpay.ts's
 * module-import time — so this file sets SYNTHETIC, fake-but-well-formed env
 * vars (never real credentials, never from any env file) before dynamically
 * importing the modules under test, exactly once, so they take effect.
 *
 * `processWebhookEvent` is exercised directly with a stubbed subscription (no
 * `fetchSubscription` call — the real Razorpay fetch happens one layer up,
 * in webhook/route.ts, never inside this function) and with BOTH
 * `recordBillingTransaction` and `recordLedgerRow` overridden via the
 * existing test seam, so the `admin` client passed in is never actually
 * dereferenced (confirmed by reading the source: `defaultLedgerWriter(admin)`
 * /`defaultBillingTransactionWriter(admin)` are only constructed via `??`
 * short-circuit when no override is given, and `applySubscriptionToProfiles`
 * — the only other consumer of `admin` — never runs for a non-subscription.*
 * event).
 *
 * This suite proves the APPLICATION CODE constructs the right rows. It does
 * NOT prove Postgres's actual UNIQUE constraint / `ON CONFLICT` behavior —
 * that requires applying migration 043 to a real database, which stays
 * separately gated (see supabase/migrations/043_billing_transactions.sql's
 * own "NOT YET VERIFIED AGAINST A REAL DATABASE" note). Not claimed here.
 *
 * Run: npx tsx test/razorpay-refund-ledger-suite.ts
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RazorpaySubscription } from '../src/lib/razorpay';

// Synthetic, fake-but-well-formed env — set BEFORE the dynamic import below
// so razorpay.ts's module-load-time isRazorpayConfigured sees it. Never a
// real key, never from any env file, never touches any real project.
process.env.RAZORPAY_KEY_ID = 'rzp_test_syntheticPureUnitOnly';
process.env.RAZORPAY_KEY_SECRET = 'synthetic_secret_never_real';
process.env.RAZORPAY_PRO_PLAN_ID = 'plan_syntheticInr';
process.env.RAZORPAY_PRO_PLAN_ID_USD = 'plan_syntheticUsd';

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

const FAKE_ADMIN = {} as SupabaseClient;

function stubSub(overrides: Partial<RazorpaySubscription> & Pick<RazorpaySubscription, 'id' | 'plan_id'>): RazorpaySubscription {
  return {
    status: 'active',
    paid_count: 1,
    customer_id: null,
    current_end: null,
    notes: { userId: 'profile_stub_user' },
    ...overrides,
  };
}

type CapturedRow = {
  profile_id: string;
  razorpay_payment_id: string;
  razorpay_refund_id: string;
  razorpay_subscription_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  razorpay_event_id: string | null;
};

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — REFUND LEDGER ROW CONSTRUCTION SUITE (pure unit, synthetic env)');
  console.log('='.repeat(78));

  const { processWebhookEvent } = await import('../src/lib/razorpay-webhook-apply');
  const ourSub = stubSub({ id: 'sub_our_pro_plan', plan_id: 'plan_syntheticInr' });

  console.log('\nMultiple partial refunds on the SAME payment produce DISTINCT rows (round-3 fix, P1 item 1)');
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    const paymentId = 'pay_two_partial_refunds';

    await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_refund_one',
      eventType: 'refund.created',
      subscription: ourSub,
      refund: { id: 'rfnd_one', amount: 10000, currency: 'INR', payment_id: paymentId, status: 'processed' },
    }, seam);

    await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_refund_two',
      eventType: 'refund.created',
      subscription: ourSub,
      refund: { id: 'rfnd_two', amount: 15000, currency: 'INR', payment_id: paymentId, status: 'processed' },
    }, seam);

    assert(captured.length === 2, 'two distinct refund.created events on the same payment construct TWO rows, not one overwriting the other', captured);
    assert(
      captured[0].razorpay_payment_id === paymentId && captured[1].razorpay_payment_id === paymentId,
      'both rows correctly carry the same parent payment id',
      captured
    );
    assert(
      captured[0].razorpay_refund_id === 'rfnd_one' && captured[1].razorpay_refund_id === 'rfnd_two',
      'each row carries its OWN distinct refund id — the composite key (payment_id, status, refund_id) differs between them even though payment_id AND status ("refunded") are identical for both',
      captured
    );
    assert(
      captured[0].amount_minor === 10000 && captured[1].amount_minor === 15000,
      'each row carries the REFUND\'s OWN amount (10000, then 15000) — never the parent payment\'s total amount',
      captured
    );
  }

  console.log('\nRedelivery of the SAME refund event collapses onto the SAME row (idempotent), not a third row');
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    const paymentId = 'pay_redelivered_refund';
    const refund = { id: 'rfnd_redelivered', amount: 5000, currency: 'INR', payment_id: paymentId, status: 'processed' };

    await processWebhookEvent(FAKE_ADMIN, { eventId: 'evt_redelivery_first', eventType: 'refund.created', subscription: ourSub, refund }, seam);
    await processWebhookEvent(FAKE_ADMIN, { eventId: 'evt_redelivery_second', eventType: 'refund.created', subscription: ourSub, refund }, seam);

    assert(
      captured.length === 2 && captured[0].razorpay_refund_id === captured[1].razorpay_refund_id && captured[0].razorpay_payment_id === captured[1].razorpay_payment_id,
      'two deliveries of the SAME refund (same refund id, same payment id, same status) construct rows with an IDENTICAL composite key both times — once migration 043 is applied, the second upsert lands on the SAME row rather than creating a duplicate',
      captured
    );
  }

  console.log('\nA refund event takes priority over a payment snapshot when BOTH are present on the event');
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_refund_with_payment',
      eventType: 'refund.created',
      subscription: ourSub,
      payment: { id: 'pay_parent_unchanged', amount: 100000, currency: 'INR', status: 'captured' },
      refund: { id: 'rfnd_priority', amount: 20000, currency: 'INR', payment_id: 'pay_parent_unchanged', status: 'processed' },
    }, seam);

    assert(captured.length === 1, 'exactly ONE row is written, not two (one for the refund, one for the unchanged parent payment snapshot)', captured);
    assert(
      captured[0].razorpay_refund_id === 'rfnd_priority' && captured[0].amount_minor === 20000 && captured[0].status === 'refunded',
      'the row written is the REFUND row (its own id, its own amount, status "refunded") — not a duplicate payment-snapshot row for the unchanged parent capture',
      captured
    );
  }

  console.log('\nAn ordinary payment event (no refund) still writes a payment-snapshot row with razorpay_refund_id as the empty-string sentinel');
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_plain_capture',
      eventType: 'payment.captured',
      subscription: ourSub,
      payment: { id: 'pay_plain_capture', amount: 49900, currency: 'INR', status: 'captured' },
    }, seam);

    assert(
      captured.length === 1 && captured[0].razorpay_refund_id === '' && captured[0].status === 'captured' && captured[0].amount_minor === 49900,
      'a plain capture (no refund entity) still writes a payment-snapshot row, with razorpay_refund_id as the empty-string sentinel (never a real refund id)',
      captured
    );
  }

  console.log('\nNo ledger entry is ever fabricated when ownership/association cannot be established (round-3 fix, P1 item 2)');
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    const unownedSub = stubSub({ id: 'sub_unowned_refund', plan_id: 'plan_definitelyNotRecognizedByThisProcess' });
    const result = await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_unowned_refund',
      eventType: 'refund.created',
      subscription: unownedSub,
      refund: { id: 'rfnd_unowned', amount: 5000, currency: 'INR', payment_id: 'pay_unowned', status: 'processed' },
    }, seam);
    assert(result.status === 200, 'the webhook still returns 200 for an unrecognized-plan refund event (acknowledged, not an error)', result);
    assert(captured.length === 0, 'no billing_transactions row is constructed/written when the subscription is not recognized as one of ours — never fabricated', captured);
  }
  {
    const captured: CapturedRow[] = [];
    const seam = {
      recordBillingTransaction: async (row: CapturedRow) => { captured.push(row); return { error: null }; },
      recordLedgerRow: async () => ({ error: null }),
    };
    const result = await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_no_subscription',
      eventType: 'refund.created',
      subscription: null,
      refund: { id: 'rfnd_no_sub', amount: 5000, currency: 'INR', payment_id: 'pay_no_sub', status: 'processed' },
    }, seam);
    assert(result.status === 200, 'the webhook still returns 200 with no subscription resolved', result);
    assert(captured.length === 0, 'with no subscription to attribute to (e.g. the upstream fetch failed), no row is constructed — the refund is never silently fabricated against a guess', captured);
  }

  console.log('\\nA failed billing-ledger write must leave the webhook event unhandled so Razorpay can retry');
  {
    let eventRecordAttempts = 0;
    const result = await processWebhookEvent(FAKE_ADMIN, {
      eventId: 'evt_ledger_write_failure',
      eventType: 'payment.captured',
      subscription: ourSub,
      payment: { id: 'pay_ledger_write_failure', amount: 49900, currency: 'INR', status: 'captured' },
    }, {
      recordBillingTransaction: async () => ({ error: new Error('simulated transient database failure') }),
      recordLedgerRow: async () => { eventRecordAttempts++; return { error: null }; },
    });
    assert(result.status === 503, 'billing-ledger write failure returns retryable 503', result);
    assert(eventRecordAttempts === 0, 'webhook event is NOT marked handled when its billing row failed', eventRecordAttempts);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
