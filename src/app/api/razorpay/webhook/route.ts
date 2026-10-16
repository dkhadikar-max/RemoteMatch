import { NextRequest, NextResponse } from 'next/server';
import {
  fetchSubscription,
  isProPlanSubscription,
  isRazorpayWebhookConfigured,
  planTierForStatus,
  subscriptionUserId,
  verifyWebhookSignature,
} from '@/lib/razorpay';
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
 * Orphan fallback: if no profile holds the subscription id AND Razorpay's live
 * status grants Pro on our plan, the subscription is (re)bound to the profile
 * named by its notes.userId — set by our own server at creation, read back
 * from Razorpay's API, never from the event body. Otherwise a user who paid a
 * subscription that was no longer the stored one would be charged without
 * Pro. An unpaid or non-Pro-plan orphan is never bound.
 *
 * Idempotency: X-Razorpay-Event-Id is recorded in razorpay_webhook_events AFTER
 * a successful apply, so a failed apply is retried by Razorpay rather than
 * swallowed; an already-recorded id short-circuits to 200.
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

  let event: { event?: string; payload?: { subscription?: { entity?: { id?: string } } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const eventType = typeof event.event === 'string' ? event.event : '';
  const eventId = req.headers.get('x-razorpay-event-id');

  if (eventId) {
    const { data: seen } = await admin
      .from('razorpay_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();
    if (seen) return NextResponse.json({ received: true, duplicate: true });
  }

  const subscriptionId = event.payload?.subscription?.entity?.id;
  if (eventType.startsWith('subscription.') && typeof subscriptionId === 'string') {
    let subscription;
    try {
      subscription = await fetchSubscription(subscriptionId);
    } catch {
      // Let Razorpay retry rather than recording an event we couldn't apply.
      return NextResponse.json({ error: 'Could not read subscription' }, { status: 502 });
    }

    const tier = planTierForStatus(subscription.status);
    const fields = {
      plan_tier: tier,
      razorpay_customer_id: subscription.customer_id ?? null,
      razorpay_subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    };

    const { data: matched, error } = await admin
      .from('profiles')
      .update(fields)
      .eq('razorpay_subscription_id', subscriptionId)
      .select('id');
    if (error) {
      return NextResponse.json({ error: 'Could not apply event' }, { status: 500 });
    }

    const boundUserId = subscriptionUserId(subscription);
    if ((matched?.length ?? 0) === 0 && tier === 'pro' && boundUserId && isProPlanSubscription(subscription)) {
      const { error: rebindError } = await admin
        .from('profiles')
        .update({ ...fields, razorpay_subscription_id: subscriptionId })
        .eq('id', boundUserId);
      if (rebindError) {
        return NextResponse.json({ error: 'Could not apply event' }, { status: 500 });
      }
      console.warn('[razorpay] re-bound orphaned paid subscription', subscriptionId, 'to its notes.userId profile');
    }
  }
  // Any other event type is acknowledged and ignored.

  if (eventId) {
    // A concurrent duplicate may have inserted first — the apply above is
    // idempotent, so a conflict here is harmless.
    await admin
      .from('razorpay_webhook_events')
      .upsert({ event_id: eventId, event_type: eventType || 'unknown' }, { onConflict: 'event_id', ignoreDuplicates: true });
  }

  return NextResponse.json({ received: true });
}
