import { NextRequest, NextResponse } from 'next/server';
import { stripe, isStripeConfigured } from '@/lib/stripe';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sessionId = (body as Record<string, unknown> | null)?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return NextResponse.json({ error: 'Session ID required' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable: server storage is not configured.' },
      { status: 503 }
    );
  }

  // Rule: a mock session must NEVER approve when real Stripe is configured —
  // fixed from the prior implementation, where this branch sat OUTSIDE the
  // isStripeConfigured check and therefore fired regardless of it.
  if (sessionId.startsWith('mock_')) {
    if (isStripeConfigured) {
      return NextResponse.json({ error: 'Invalid checkout session' }, { status: 400 });
    }
    // Stripe genuinely not configured (local/demo environment only): grant
    // Pro to the AUTHENTICATED caller, never a client-supplied identity.
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

  if (!isStripeConfigured || !stripe) {
    return NextResponse.json({ error: 'Invalid checkout session' }, { status: 400 });
  }

  // Only Stripe's own verified response may establish Pro from here on.
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  } catch {
    return NextResponse.json({ error: 'Invalid checkout session' }, { status: 400 });
  }

  // Bind the session to the authenticated caller — set at checkout time via
  // client_reference_id (see src/lib/stripe.ts). Without this check, any
  // user who learned any OTHER user's valid session id could redeem it.
  if (session.client_reference_id !== user.id) {
    return NextResponse.json({ error: 'This checkout session does not belong to your account.' }, { status: 403 });
  }

  const subscription = typeof session.subscription === 'object' ? session.subscription : null;
  const subscriptionStatus = subscription?.status;
  const isPaid = session.payment_status === 'paid' || session.status === 'complete';
  const isActive = subscriptionStatus ? ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus) : isPaid;

  if (!isPaid || !isActive) {
    return NextResponse.json({ error: 'Payment not completed' }, { status: 400 });
  }

  // Idempotent by construction: replaying verify with the same valid,
  // already-active session simply re-writes the same values.
  const { data: updated, error } = await admin
    .from('profiles')
    .update({
      plan_tier: 'pro',
      stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
      stripe_subscription_id: subscription?.id ?? (typeof session.subscription === 'string' ? session.subscription : null),
      stripe_subscription_status: subscriptionStatus ?? 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id)
    .select('plan_tier')
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: 'Could not update subscription' }, { status: 500 });
  }

  return NextResponse.json({ success: true, planTier: updated.plan_tier });
}
