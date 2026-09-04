import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { stripe, isStripeConfigured } from '@/lib/stripe';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Reconciliation path for entitlement, independent of the client ever
 * calling /api/stripe/verify. Without this, a cancelled or payment-failed
 * subscription has no mechanism at all to downgrade plan_tier — it would
 * stay 'pro' indefinitely, which is one of the P0 findings this remediation
 * closes.
 *
 * Trust anchor: the Stripe signature (`stripe-signature` header) verified
 * against STRIPE_WEBHOOK_SECRET — never the request body's own content, and
 * there is deliberately no user session involved (Stripe calls this
 * server-to-server).
 */
export async function POST(req: NextRequest) {
  if (!isStripeConfigured || !stripe) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 503 });
  }
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    return NextResponse.json({ error: `Webhook signature verification failed` }, { status: 400 });
  }

  async function syncFromSubscription(customerId: string, subscription: Stripe.Subscription) {
    const planTier = ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ? 'pro' : 'free';
    await admin!
      .from('profiles')
      .update({
        plan_tier: planTier,
        stripe_subscription_id: subscription.id,
        stripe_subscription_status: subscription.status,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_customer_id', customerId);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      if (userId && typeof session.customer === 'string') {
        await admin
          .from('profiles')
          .update({
            plan_tier: 'pro',
            stripe_customer_id: session.customer,
            stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : null,
            stripe_subscription_status: 'active',
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      await syncFromSubscription(customerId, subscription);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const subscriptionId =
        typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (customerId && subscriptionId) {
        // Re-derive entitlement from the subscription's own current status
        // (Stripe moves it to 'past_due'/'unpaid'/'canceled' on repeated
        // failure) rather than hard-coding a downgrade on the first failure,
        // which would punish a single transient card decline.
        const subscription = await stripe!.subscriptions.retrieve(subscriptionId);
        await syncFromSubscription(customerId, subscription);
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
