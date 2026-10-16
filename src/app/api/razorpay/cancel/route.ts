import { NextRequest, NextResponse } from 'next/server';
import { cancelSubscriptionAtCycleEnd, isRazorpayConfigured, RazorpayApiError } from '@/lib/razorpay';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

/**
 * Self-serve cancel (Razorpay has no hosted customer portal). Cancels at the
 * end of the current billing cycle: the user keeps Pro until then, and the
 * `subscription.cancelled` webhook performs the downgrade. This route never
 * touches plan_tier itself.
 *
 * Only the subscription stored on the caller's own profile can be cancelled —
 * the id is never taken from the request.
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
    return NextResponse.json({ error: 'Billing is not available right now.' }, { status: 503 });
  }
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('razorpay_subscription_id, razorpay_subscription_status')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) {
    return NextResponse.json({ error: 'Could not load your account' }, { status: 500 });
  }
  if (!profile.razorpay_subscription_id) {
    return NextResponse.json({ error: 'No active subscription to cancel.' }, { status: 404 });
  }
  if (profile.razorpay_subscription_status === 'cancel_scheduled') {
    return NextResponse.json({ success: true, alreadyScheduled: true });
  }

  let subscription;
  try {
    subscription = await cancelSubscriptionAtCycleEnd(profile.razorpay_subscription_id);
  } catch (err) {
    const status = err instanceof RazorpayApiError ? err.status : 0;
    console.error('[razorpay] cancel failed', status, (err as Error).message);
    return NextResponse.json({ error: 'Could not cancel. Please try again.' }, { status: 502 });
  }

  // Local marker only (plan_tier untouched) so a repeat click is a no-op; the
  // webhook overwrites it with Razorpay's real status when the cycle ends.
  await admin
    .from('profiles')
    .update({ razorpay_subscription_status: 'cancel_scheduled', updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .eq('razorpay_subscription_id', profile.razorpay_subscription_id);

  return NextResponse.json({
    success: true,
    endsAt: subscription.current_end ? new Date(subscription.current_end * 1000).toISOString() : null,
  });
}
