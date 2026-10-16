import { NextRequest, NextResponse } from 'next/server';
import {
  checkoutOutcome,
  fetchSubscription,
  isRazorpayConfigured,
  subscriptionUserId,
  verifyPaymentSignature,
} from '@/lib/razorpay';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

/**
 * Step 2 of a Pro upgrade: the browser forwards Razorpay Checkout's handler
 * result. Exists only so the user sees Pro immediately — the webhook is the
 * source of truth for every later change (renewal, failure, cancellation).
 *
 * Three independent checks before plan_tier changes:
 *   1. the handler signature verifies against KEY_SECRET (the result really
 *      came from Razorpay Checkout for this payment + subscription);
 *   2. the subscription is the one stored on THIS caller's profile AND carries
 *      notes.userId === caller (a valid result for another account can never
 *      be redeemed here);
 *   3. Razorpay's API, re-read now, says the subscription grants Pro under the
 *      shared rule (planTierForSubscription: a successful charge, not merely
 *      an authorised mandate).
 * An authorised mandate whose first charge has not landed yet is NOT a
 * failure: it gets 202 { awaitingFirstCharge: true } and Pro arrives via the
 * webhook once Razorpay charges. Idempotent: replaying a valid result
 * re-writes the same values.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user } = auth;

  let body: Record<string, unknown> | null;
  try {
    body = (await req.json()) as Record<string, unknown> | null;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  if (body?.mock === true) {
    // Local/test convenience only — never when Razorpay is configured, never in
    // production. Grants Pro to the AUTHENTICATED caller, never a supplied id.
    if (isRazorpayConfigured || process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Invalid payment' }, { status: 400 });
    }
    const { data: updated, error } = await admin
      .from('profiles')
      .update({ plan_tier: 'pro', updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('plan_tier')
      .single();
    if (error || !updated) {
      return NextResponse.json({ error: 'Could not update subscription' }, { status: 500 });
    }
    return NextResponse.json({ success: true, planTier: updated.plan_tier, isMock: true });
  }

  if (!isRazorpayConfigured) {
    return NextResponse.json({ error: 'Invalid payment' }, { status: 400 });
  }

  const paymentId = body?.razorpay_payment_id;
  const subscriptionId = body?.razorpay_subscription_id;
  const signature = body?.razorpay_signature;
  if (
    typeof paymentId !== 'string' || !paymentId ||
    typeof subscriptionId !== 'string' || !subscriptionId ||
    typeof signature !== 'string' || !signature
  ) {
    return NextResponse.json({ error: 'Missing payment details' }, { status: 400 });
  }

  if (!verifyPaymentSignature({ paymentId, subscriptionId, signature })) {
    return NextResponse.json({ error: 'Invalid payment' }, { status: 400 });
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('razorpay_subscription_id')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) {
    return NextResponse.json({ error: 'Could not load your account' }, { status: 500 });
  }
  if (profile.razorpay_subscription_id !== subscriptionId) {
    return NextResponse.json({ error: 'This payment does not belong to your account.' }, { status: 403 });
  }

  let subscription;
  try {
    subscription = await fetchSubscription(subscriptionId);
  } catch {
    return NextResponse.json({ error: 'Could not confirm payment. Please try again.' }, { status: 502 });
  }
  if (subscriptionUserId(subscription) !== user.id) {
    return NextResponse.json({ error: 'This payment does not belong to your account.' }, { status: 403 });
  }
  const outcome = checkoutOutcome(subscription);
  if (outcome === 'awaiting_first_charge') {
    // Record the mandate's state (plan_tier untouched) so the profile reflects
    // it; the webhook grants Pro when the first charge succeeds.
    await admin
      .from('profiles')
      .update({
        razorpay_customer_id: subscription.customer_id ?? null,
        razorpay_subscription_status: subscription.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .eq('razorpay_subscription_id', subscriptionId);
    return NextResponse.json(
      {
        success: false,
        awaitingFirstCharge: true,
        message: 'Your payment method is set up. Pro unlocks as soon as the first payment is confirmed.',
      },
      { status: 202 }
    );
  }
  if (outcome !== 'granted') {
    return NextResponse.json({ error: 'Payment not completed' }, { status: 400 });
  }

  const { data: updated, error } = await admin
    .from('profiles')
    .update({
      plan_tier: 'pro',
      razorpay_customer_id: subscription.customer_id ?? null,
      razorpay_subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id)
    .eq('razorpay_subscription_id', subscriptionId)
    .select('plan_tier')
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: 'Could not update subscription' }, { status: 500 });
  }

  return NextResponse.json({ success: true, planTier: updated.plan_tier });
}
