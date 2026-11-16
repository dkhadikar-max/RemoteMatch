/**
 * RemoteMatch — razorpay-webhook-parse pure-unit suite.
 * ==============================================================================
 * Regression test for G1 (2026-11-05 audit,
 * docs/international-payments-audit-plan-2026-10-31.md §8.2): before this fix,
 * the webhook route only resolved a subscription id from
 * `payload.subscription.entity.id`, gated on the event type starting with
 * "subscription." — so `payment.failed`/`refund.created` (separate top-level
 * event types that carry a payment but no subscription entity) never
 * resolved a subscription at all, meaning billing_transactions could never
 * record a 'failed' or 'refunded' row. Pure, no network, no DB — tests the
 * extracted parser directly.
 *
 * Run: npx tsx test/razorpay-webhook-parse-suite.ts
 */

import { parseWebhookEvent, subscriptionFetchFailureOutcome } from '../src/lib/razorpay-webhook-parse';

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
  console.log('REMOTEMATCH — RAZORPAY WEBHOOK PARSE SUITE (pure unit, G1 regression)');
  console.log('='.repeat(78));

  console.log('\nBASELINE — unchanged behavior for subscription.* events');
  {
    const body = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_abc123' } } } });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === 'sub_abc123' && r.payment === null, 'a subscription.* event with a subscription entity resolves its id, no payment', r);
  }
  {
    const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: {} });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === undefined && r.payment === null, 'an unrelated event with an empty payload resolves nothing — matches the existing real-infra suite\'s "unhandled event" case', r);
  }

  console.log('\nG1 FIX — payment.* / refund.* events now resolve a subscription via payment.entity.subscription_id');
  {
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_fail1', amount: 900, currency: 'USD', status: 'failed', subscription_id: 'sub_renewal_fail' } } },
    });
    const r = parseWebhookEvent(body);
    assert(
      r.subscriptionId === 'sub_renewal_fail',
      'payment.failed (no subscription.entity at all) resolves its subscription id from payment.entity.subscription_id — THE actual G1 fix',
      r
    );
    assert(
      r.payment !== null && r.payment.id === 'pay_fail1' && r.payment.status === 'failed' && r.payment.amount === 900 && r.payment.currency === 'USD',
      'the failed payment entity itself is still extracted correctly',
      r.payment
    );
  }
  {
    const body = JSON.stringify({
      event: 'refund.created',
      payload: { payment: { entity: { id: 'pay_refunded1', amount: 49900, currency: 'INR', status: 'refunded', subscription_id: 'sub_was_refunded' } } },
    });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === 'sub_was_refunded', 'refund.created also resolves its subscription id from the payment entity', r);
  }
  {
    // A payment entity with no subscription_id at all (a genuinely standalone,
    // non-subscription payment) must not invent one.
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_standalone', amount: 500, currency: 'INR', status: 'captured' } } } });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === undefined, 'a payment with no subscription_id field resolves no subscription — never invented', r);
    assert(r.payment !== null && r.payment.id === 'pay_standalone', 'the standalone payment entity is still extracted (ownership gating happens downstream, in processWebhookEvent)', r.payment);
  }

  console.log('\nPRECEDENCE — when both sources are present, the subscription entity wins');
  {
    const body = JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_from_subscription_entity' } },
        payment: { entity: { id: 'pay_x', amount: 900, currency: 'USD', status: 'captured', subscription_id: 'sub_from_payment_entity' } },
      },
    });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === 'sub_from_subscription_entity', 'when both sources are present, the dedicated subscription.entity.id is used (not the payment\'s subscription_id)', r);
  }

  console.log('\nMALFORMED PAYMENT ENTITY — never partially trusted');
  {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_partial', amount: 900 /* missing currency, status */ } } } });
    const r = parseWebhookEvent(body);
    assert(r.payment === null, 'a payment entity missing required fields is treated as absent entirely, not partially used', r);
  }
  {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_badamount', amount: '900', currency: 'USD', status: 'captured' } } } });
    const r = parseWebhookEvent(body);
    assert(r.payment === null, 'a payment entity with the wrong TYPE for a field (amount as a string) is rejected, not coerced', r);
  }

  console.log('\nREFUND PAYLOAD PARSING (2026-11-07 round-3 review fix, P1 items 1+2) — representative Razorpay refund.created payload');
  {
    // Representative of Razorpay's REAL refund.created shape: payload.refund
    // is the refund's OWN entity (own id, own amount — here a PARTIAL refund
    // of a larger payment); payload.payment is the PARENT payment, whose own
    // `status` still reads 'captured' for a partial refund (never
    // 'refunded') — exactly the case the prior (payment.entity.status-only)
    // parsing could not distinguish from an ordinary capture.
    const body = JSON.stringify({
      event: 'refund.created',
      payload: {
        payment: { entity: { id: 'pay_partial_refund_target', amount: 100000, currency: 'INR', status: 'captured', subscription_id: 'sub_partial_refund' } },
        refund: { entity: { id: 'rfnd_first', amount: 30000, currency: 'INR', payment_id: 'pay_partial_refund_target', status: 'processed' } },
      },
    });
    const r = parseWebhookEvent(body);
    assert(r.subscriptionId === 'sub_partial_refund', 'subscription id still resolves via payload.payment.entity.subscription_id when a refund entity is also present', r);
    assert(
      r.refund !== null &&
        r.refund.id === 'rfnd_first' &&
        r.refund.amount === 30000 &&
        r.refund.currency === 'INR' &&
        r.refund.payment_id === 'pay_partial_refund_target' &&
        r.refund.status === 'processed',
      'payload.refund.entity is extracted as its own entity — its OWN id and OWN (partial) amount, distinct from the parent payment\'s total',
      r.refund
    );
    assert(
      r.payment !== null && r.payment.status === 'captured' && r.payment.amount === 100000,
      'the parent payment entity is ALSO still extracted, correctly still showing status "captured" (not "refunded") for a partial refund — proving the old payment.entity.status-only parsing could not have distinguished this from an ordinary capture',
      r.payment
    );
  }
  {
    // A malformed/incomplete refund entity must never be partially trusted —
    // same invariant as the payment entity.
    const body = JSON.stringify({
      event: 'refund.created',
      payload: { refund: { entity: { id: 'rfnd_malformed', amount: 500 /* missing currency, payment_id, status */ } } },
    });
    const r = parseWebhookEvent(body);
    assert(r.refund === null, 'a refund entity missing required fields is treated as absent entirely, never partially used', r);
  }
  {
    // An event with no refund entity at all (an ordinary payment.captured)
    // must not invent one.
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_no_refund', amount: 900, currency: 'USD', status: 'captured' } } } });
    const r = parseWebhookEvent(body);
    assert(r.refund === null, 'an ordinary payment.captured event (no refund entity in the payload) resolves refund: null — never fabricated', r);
  }

  console.log('\nsubscriptionFetchFailureOutcome (2026-11-07 round-3 review fix, P2 item 4) — pure decision logic');
  assert(
    subscriptionFetchFailureOutcome({ isLifecycleEvent: true, hasPayment: false, hasRefund: false }) === 'retry',
    'a subscription.* event always retries on fetch failure, even with no payment/refund payload'
  );
  assert(
    subscriptionFetchFailureOutcome({ isLifecycleEvent: false, hasPayment: false, hasRefund: false }) === 'acknowledge',
    'a non-lifecycle event with NO financial payload may acknowledge a fetch failure — nothing would be lost'
  );
  assert(
    subscriptionFetchFailureOutcome({ isLifecycleEvent: false, hasPayment: true, hasRefund: false }) === 'retry',
    'a non-lifecycle event carrying a PAYMENT must retry on fetch failure — its ledger row could never be attributed otherwise, and the event would still be marked handled, permanently losing that financial record'
  );
  assert(
    subscriptionFetchFailureOutcome({ isLifecycleEvent: false, hasPayment: false, hasRefund: true }) === 'retry',
    'a non-lifecycle event carrying a REFUND must retry on fetch failure — same reasoning as the payment case'
  );

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
