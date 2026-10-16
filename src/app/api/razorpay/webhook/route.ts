import { NextRequest, NextResponse } from 'next/server';
import {
  fetchSubscription,
  isProPlanSubscription,
  isRazorpayWebhookConfigured,
  orphanDecision,
  planTierForSubscription,
  RazorpayApiError,
  subscriptionUserId,
  verifyWebhookSignature,
} from '@/lib/razorpay';
import { isActiveClaim } from '@/lib/razorpay-claim';
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
 * Orphans (no profile holds the subscription id): only a subscription that
 * grants Pro under the shared rule, on our plan, is considered, against the
 * profile named by its notes.userId (set by our server at creation, read back
 * from Razorpay's API, never from the event body). What that profile ALREADY
 * holds decides — never its plan_tier alone (a Free profile can still hold a
 * live mandate):
 *   - nothing, or a subscription that can no longer charge → bind (a
 *     compare-and-swap on the observed stored id, so a concurrent change wins);
 *   - a different subscription with a LIVE mandate → do not touch the binding;
 *     record an explicit `reconcile.duplicate_live_mandate` ledger row for a
 *     human (two mandates on one customer = possible double charge).
 * A profile mid-checkout-claim (src/lib/razorpay-claim.ts) is never written
 * here; an orphan arriving during one gets a 503 so Razorpay retries later.
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

  const retryLater = (error: string, status = 503) => NextResponse.json({ error }, { status });
  let reconcile = false;

  const subscriptionId = event.payload?.subscription?.entity?.id;
  if (eventType.startsWith('subscription.') && typeof subscriptionId === 'string') {
    let subscription;
    try {
      subscription = await fetchSubscription(subscriptionId);
    } catch {
      // Let Razorpay retry rather than recording an event we couldn't apply.
      return retryLater('Could not read subscription', 502);
    }

    const fields = {
      plan_tier: planTierForSubscription(subscription),
      razorpay_customer_id: subscription.customer_id ?? null,
      razorpay_subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    };

    const { data: holder, error: holderError } = await admin
      .from('profiles')
      .select('id, razorpay_subscription_status')
      .eq('razorpay_subscription_id', subscriptionId)
      .maybeSingle();
    if (holderError) return retryLater('Could not apply event', 500);

    if (holder) {
      // Normal path. A holder mid-claim is replacing this (ended) subscription
      // and is Free by construction — nothing to apply, and writing would
      // clobber the claim.
      if (!isActiveClaim(holder.razorpay_subscription_status)) {
        const { error } = await admin
          .from('profiles')
          .update(fields)
          .eq('id', holder.id)
          .eq('razorpay_subscription_id', subscriptionId);
        if (error) return retryLater('Could not apply event', 500);
      }
    } else {
      const targetId = subscriptionUserId(subscription);
      if (targetId && isProPlanSubscription(subscription) && fields.plan_tier === 'pro') {
        const { data: target, error: targetError } = await admin
          .from('profiles')
          .select('id, razorpay_subscription_id, razorpay_subscription_status')
          .eq('id', targetId)
          .maybeSingle();
        if (targetError) return retryLater('Could not apply event', 500);
        if (target) {
          if (isActiveClaim(target.razorpay_subscription_status)) {
            return retryLater('Profile is mid-checkout; retry later');
          }
          const storedId: string | null = target.razorpay_subscription_id;
          let stored = null;
          if (storedId) {
            try {
              stored = await fetchSubscription(storedId);
            } catch (err) {
              const status = err instanceof RazorpayApiError ? err.status : 0;
              if (status !== 400 && status !== 404) return retryLater('Could not read stored subscription', 502);
              // Unknown to Razorpay: holds nothing that can charge.
            }
          }

          const decision = orphanDecision(subscription, stored);
          if (decision === 'bind') {
            let bind = admin
              .from('profiles')
              .update({ ...fields, razorpay_subscription_id: subscriptionId })
              .eq('id', target.id);
            bind = storedId === null ? bind.is('razorpay_subscription_id', null) : bind.eq('razorpay_subscription_id', storedId);
            const { data: bound, error: bindError } = await bind.select('id');
            if (bindError) return retryLater('Could not apply event', 500);
            // Binding changed under us: retry so the decision is re-made on fresh state.
            if ((bound?.length ?? 0) === 0) return retryLater('Profile changed; retry later');
            console.warn('[razorpay] bound paid orphan subscription to its notes.userId profile', subscriptionId);
          } else if (decision === 'reconcile') {
            reconcile = true;
            await admin.from('razorpay_webhook_events').upsert(
              {
                event_id: `reconcile:${subscriptionId}:${storedId}`,
                event_type: 'reconcile.duplicate_live_mandate',
              },
              { onConflict: 'event_id', ignoreDuplicates: true }
            );
            console.error(
              '[razorpay][RECONCILE] paid subscription',
              subscriptionId,
              'not bound: profile already holds live mandate',
              storedId
            );
          }
        }
      }
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

  return NextResponse.json(reconcile ? { received: true, reconcile: true } : { received: true });
}
