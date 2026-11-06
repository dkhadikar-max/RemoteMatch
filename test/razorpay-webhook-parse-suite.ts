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

import { parseWebhookEvent } from '../src/lib/razorpay-webhook-parse';

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

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
