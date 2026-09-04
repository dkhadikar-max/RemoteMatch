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
  userEmail: string;
  returnUrl: string;
}): Promise<{ url: string | null; isMock?: boolean }> {
  if (!stripe) {
    // If Stripe is not configured yet, return a mock success redirect
    return {
      url: `${params.returnUrl}?session_id=mock_session_success&tier=pro`,
      isMock: true,
    };
  }

  const priceId = process.env.STRIPE_PRO_PRICE_ID;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    customer_email: params.userEmail,
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
