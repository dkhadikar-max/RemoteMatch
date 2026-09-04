import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY;

export const isStripeConfigured = Boolean(stripeKey && stripeKey.startsWith('sk_'));

export const stripe = isStripeConfigured
  ? new Stripe(stripeKey!, {
      apiVersion: '2024-09-30.acacia' as any,
    })
  : null;

export async function createCheckoutSession(params: {
  userId: string;
  userEmail?: string | null;
  returnUrl: string;
}): Promise<{ url: string | null; isMock?: boolean }> {
  if (!stripe) {
    // If Stripe is not configured yet, return a mock success redirect.
    // The verify route only ever honors this for the SAME authenticated
    // user and only while Stripe remains unconfigured — see
    // src/app/api/stripe/verify/route.ts.
    return {
      url: `${params.returnUrl}?session_id=mock_session_success&tier=pro`,
      isMock: true,
    };
  }

  const priceId = process.env.STRIPE_PRO_PRICE_ID;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    // Anonymous-auth users have no email yet; Stripe will collect one at
    // checkout instead of us passing an invalid/empty value.
    ...(params.userEmail ? { customer_email: params.userEmail } : {}),
    // The canonical Stripe-native binding of a session to our own user id —
    // read back and verified server-side in /api/stripe/verify and the
    // webhook so a session can never be redeemed for a different user.
    client_reference_id: params.userId,
    line_items: priceId
      ? [{ price: priceId, quantity: 1 }]
      : [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'RemoteMatch Pro',
                description: 'Unlimited job evaluations, deep AI match analysis, and tailored application kits.',
              },
              unit_amount: 1200, // $12.00
              recurring: { interval: 'month' },
            },
            quantity: 1,
          },
        ],
    success_url: `${params.returnUrl}?session_id={CHECKOUT_SESSION_ID}&tier=pro`,
    cancel_url: `${params.returnUrl}?canceled=true`,
    metadata: {
      userId: params.userId,
    },
  });

  return { url: session.url };
}
