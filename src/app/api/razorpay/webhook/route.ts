import { NextRequest, NextResponse } from 'next/server';
import { fetchSubscription, isRazorpayWebhookConfigured, verifyWebhookSignature } from '@/lib/razorpay';
import { processWebhookEvent } from '@/lib/razorpay-webhook-apply';
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

  let subscription = null;
  const subscriptionId = event.payload?.subscription?.entity?.id;
  if (eventType.startsWith('subscription.') && typeof subscriptionId === 'string') {
    try {
      subscription = await fetchSubscription(subscriptionId);
    } catch {
      // Let Razorpay retry rather than recording an event we couldn't apply.
      return NextResponse.json({ error: 'Could not read subscription' }, { status: 502 });
    }
  }
  // Any other event type carries no subscription: acknowledged and recorded.

  // Apply, then record the event only if the apply succeeded; any non-2xx
  // leaves it unrecorded so Razorpay redelivers.
  const result = await processWebhookEvent(admin, { eventId, eventType, subscription });
  return NextResponse.json(result.body, { status: result.status });
}
