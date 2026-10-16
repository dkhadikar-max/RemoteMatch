import { NextRequest, NextResponse } from 'next/server';
import {
  createSubscription,
  fetchSubscription,
  isProPlanSubscription,
  isRazorpayConfigured,
  planTierForStatus,
  razorpayKeyId,
  RazorpayApiError,
  subscriptionUserId,
} from '@/lib/razorpay';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

/**
 * Step 1 of a Pro upgrade: create a Razorpay subscription bound to the
 * authenticated caller and hand the browser what Checkout needs. Creating a
 * subscription grants nothing — Pro is only ever set by /verify or the webhook
 * after Razorpay itself confirms the mandate/charge.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user } = auth;

  if (!isRazorpayConfigured) {
    // Same rule as the Stripe hardening: in production, "unconfigured" means
    // "upgrades unavailable" — never a free Pro. The mock exists purely as a
    // local/test convenience and is redeemed by /verify for the caller only.
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: "Pro upgrades aren't available right now. Please check back soon." },
        { status: 503 }
      );
    }
    return NextResponse.json({ success: true, isMock: true });
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('plan_tier, razorpay_subscription_id')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) {
    return NextResponse.json({ error: 'Could not load your account' }, { status: 500 });
  }
  if (profile.plan_tier === 'pro') {
    return NextResponse.json({ error: 'You already have RemoteMatch Pro.' }, { status: 409 });
  }

  // Reuse the stored subscription while it is still unpaid ('created') rather
  // than minting a new one. Replacing it would orphan the earlier one: a user
  // with checkout open in two tabs (or retrying after a reload) who then pays
  // the EARLIER subscription would be charged with no profile bound to it.
  if (profile.razorpay_subscription_id) {
    let existing;
    try {
      existing = await fetchSubscription(profile.razorpay_subscription_id);
    } catch (err) {
      const status = err instanceof RazorpayApiError ? err.status : 0;
      // 400/404: the stored id is unusable — fall through and create a fresh
      // one. Anything else is transient; refuse rather than risk an orphan.
      if (status !== 400 && status !== 404) {
        console.error('[razorpay] fetch stored subscription failed', status, (err as Error).message);
        return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
      }
    }
    if (existing && isProPlanSubscription(existing) && subscriptionUserId(existing) === user.id) {
      if (existing.status === 'created') {
        return NextResponse.json({
          success: true,
          subscriptionId: existing.id,
          keyId: razorpayKeyId,
          email: user.email ?? null,
        });
      }
      if (planTierForStatus(existing.status) === 'pro') {
        // Paid, but Pro not applied yet (verify failed / webhook in flight).
        // A second subscription here would double-charge.
        return NextResponse.json(
          { error: 'Your payment is being confirmed. Please refresh in a minute.' },
          { status: 409 }
        );
      }
      // halted / cancelled / completed / expired: start a new one below.
    }
  }

  let subscription;
  try {
    subscription = await createSubscription({ userId: user.id });
  } catch (err) {
    const status = err instanceof RazorpayApiError ? err.status : 0;
    console.error('[razorpay] create subscription failed', status, (err as Error).message);
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
  }

  // Store the binding before the browser ever sees the id: /verify and the
  // webhook both resolve the user from this column. Reaching here means any
  // earlier stored subscription is unusable (gone, ended, or not ours/this plan).
  const { error: updateError } = await admin
    .from('profiles')
    .update({
      razorpay_subscription_id: subscription.id,
      razorpay_subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  if (updateError) {
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    subscriptionId: subscription.id,
    keyId: razorpayKeyId,
    email: user.email ?? null,
  });
}
