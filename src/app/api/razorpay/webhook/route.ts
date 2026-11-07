import { NextRequest, NextResponse } from 'next/server';
import { fetchSubscription, isRazorpayWebhookConfigured, verifyWebhookSignature } from '@/lib/razorpay';
import { processWebhookEvent } from '@/lib/razorpay-webhook-apply';
import { parseWebhookEvent, subscriptionFetchFailureOutcome } from '@/lib/razorpay-webhook-parse';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

/**
 * Entitlement reconciliation, independent of the browser ever calling /verify:
 * renewals, failed charges, halts and cancellations all land here.
 *
 * Trust anchor: X-Razorpay-Signature verified against RAZORPAY_WEBHOOK_SECRET
 * over the raw body. No user session (Razorpay calls this server-to-server).
 *
 * The event body only tells us WHICH subscription changed. The tier is derived
 * from Razorpay's API re-read now, never from the event type — so out-of-order
 * or late redeliveries (e.g. an old `charged` arriving after `cancelled`) can't
 * flip a user back to the wrong state. The user is resolved by the stored
 * subscription id (unique, migration 032), never by anything in the body.
 *
 * Applying it to profiles — holder path, orphan path, reconcile case, and the
 * compare-and-swap that keeps a concurrently-acquired checkout claim from ever
 * being overwritten — lives in src/lib/razorpay-webhook-apply.ts.
 *
 * Orphans (no profile holds the subscription id): only a subscription that
 * grants Pro under the shared rule, on our plan, is considered, against the
 * profile named by its notes.userId (set by our server at creation, read back
 * from Razorpay's API, never from the event body). What that profile ALREADY
 * holds decides — never its plan_tier alone:
 *   - nothing, or a subscription that can no longer charge → bind;
 *   - a different subscription with a LIVE mandate → do not touch the binding;
 *     record an explicit `reconcile.duplicate_live_mandate` ledger row.
 *
 * Idempotency: X-Razorpay-Event-Id is recorded in razorpay_webhook_events AFTER
 * a successful apply, so a failed or unresolved apply (non-2xx) is retried by
 * Razorpay rather than swallowed; an already-recorded id short-circuits to 200.
 */
export async function POST(req: NextRequest) {
  if (!isRazorpayWebhookConfigured) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  const signature = req.headers.get('x-razorpay-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }
  const rawBody = await req.text();
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Webhook signature verification failed' }, { status: 400 });
  }

  // Parsing — including the G1 fix (2026-11-05): resolving the subscription
  // id from EITHER `payload.subscription.entity.id` (subscription.* events)
  // OR `payload.payment.entity.subscription_id` (payment.failed,
  // payment.captured, refund.created, etc. — separate top-level event types
  // that carry a payment but no subscription entity of their own), never
  // gated on the event type string, consistent with this route's own stated
  // principle above ("never from the event type") — lives in
  // razorpay-webhook-parse.ts, pure and independently unit-tested, so this
  // exact fix is regression-tested without needing a live server or a real
  // Razorpay subscription (test/razorpay-webhook-parse-suite.ts). Before this
  // fix, only the subscription-entity source was read, so a failed renewal
  // charge or a refund never resolved a subscription at all — entitlement
  // was unaffected (Razorpay's own subscription.pending/halted events, which
  // DO carry a subscription entity, still drove that correctly) but
  // billing_transactions could never record a 'failed' or 'refunded' row,
  // despite the schema explicitly supporting both.
  let parsed: ReturnType<typeof parseWebhookEvent>;
  try {
    parsed = parseWebhookEvent(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { eventType, subscriptionId, payment, refund } = parsed;
  const eventId = req.headers.get('x-razorpay-event-id');

  if (eventId) {
    const { data: seen } = await admin
      .from('razorpay_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();
    if (seen) return NextResponse.json({ received: true, duplicate: true });
  }

  // 2026-11-06 review fix (requirement #2): only subscription.* events are
  // entitlement-critical — a failed fetch for one of those must force a
  // retry, since applying the wrong/stale state would be worse than being
  // slow. A payment.*/refund.* event only needs the fetch for billing_
  // transactions ledger attribution (itself best-effort — see
  // razorpay-webhook-apply.ts).
  //
  // 2026-11-07 round-3 review fix (P2 item 4): "best-effort" stops being
  // true the moment the event actually carries a payment or refund entity —
  // if the fetch fails AND we never attribute that financial event, it
  // still gets recorded as "handled" below (idempotency), permanently
  // losing that ledger record with no reconciliation path. Such an event
  // must retry too; only an event with no financial payload at all (nothing
  // to lose) may be acknowledged despite a failed fetch. See
  // subscriptionFetchFailureOutcome (razorpay-webhook-parse.ts) for the pure,
  // independently-tested decision.
  const isSubscriptionLifecycleEvent = eventType.startsWith('subscription.');
  let subscription = null;
  if (typeof subscriptionId === 'string') {
    try {
      subscription = await fetchSubscription(subscriptionId);
    } catch (err) {
      const outcome = subscriptionFetchFailureOutcome({
        isLifecycleEvent: isSubscriptionLifecycleEvent,
        hasPayment: payment !== null,
        hasRefund: refund !== null,
      });
      if (outcome === 'retry') {
        // Let Razorpay retry rather than recording an event we couldn't
        // apply, or whose financial record we couldn't attribute.
        return NextResponse.json({ error: 'Could not read subscription' }, { status: 502 });
      }
      console.error(
        '[razorpay][webhook] could not fetch subscription for ledger context (non-fatal, no financial payload on this event)',
        eventType,
        subscriptionId,
        err
      );
    }
  }
  // An event with no subscription id from either source carries no
  // subscription: acknowledged and recorded.

  // Apply, then record the event only if the apply succeeded; any non-2xx
  // leaves it unrecorded so Razorpay redelivers.
  const result = await processWebhookEvent(admin, { eventId, eventType, subscription, payment, refund });
  return NextResponse.json(result.body, { status: result.status });
}
