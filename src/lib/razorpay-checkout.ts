'use client';

import { notifyEntitlementChanged } from '@/lib/entitlement/client';

/**
 * The single client-side Pro upgrade flow (upgrade modal + /settings both use
 * it). Server routes do every trust decision; this only drives Razorpay's
 * Checkout modal and forwards its handler result to /api/razorpay/verify.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export type UpgradeResult =
  | { status: 'upgraded' }
  | { status: 'dismissed' }
  | { status: 'error'; message: string };

interface RazorpayHandlerResult {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHECKOUT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null; // allow a retry on the next click
        reject(new Error('checkout script failed to load'));
      };
      document.body.appendChild(script);
    });
  }
  return scriptPromise;
}

async function verify(body: Record<string, unknown>): Promise<UpgradeResult> {
  const res = await fetch('/api/razorpay/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.success) {
    // Plan just changed server-side — listeners refetch /api/profile.
    notifyEntitlementChanged();
    return { status: 'upgraded' };
  }
  return {
    status: 'error',
    message: data.error ?? 'We could not confirm your payment. If you were charged, it will be applied shortly.',
  };
}

export async function startProUpgrade(): Promise<UpgradeResult> {
  try {
    const res = await fetch('/api/razorpay/subscription', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { status: 'error', message: data.error ?? 'Could not start checkout. Please try again.' };
    }

    if (data.isMock) return verify({ mock: true });

    await loadCheckoutScript();
    if (!window.Razorpay) {
      return { status: 'error', message: 'Could not load checkout. Please try again.' };
    }

    const brandColor =
      getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || undefined;

    return await new Promise<UpgradeResult>((resolve) => {
      let settled = false;
      const settle = (r: UpgradeResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      const rzp = new window.Razorpay!({
        key: data.keyId,
        subscription_id: data.subscriptionId,
        name: 'RemoteMatch',
        description: 'RemoteMatch Pro — ₹499/month',
        prefill: data.email ? { email: data.email } : undefined,
        theme: brandColor ? { color: brandColor } : undefined,
        handler: (resp: RazorpayHandlerResult) => {
          verify({ ...resp }).then(settle, () =>
            settle({ status: 'error', message: 'We could not confirm your payment. If you were charged, it will be applied shortly.' })
          );
        },
        modal: { ondismiss: () => settle({ status: 'dismissed' }) },
      });
      // A failed payment is retried inside Checkout's own modal, so only the
      // handler (success) or dismissing the modal settles this promise.
      rzp.open();
    });
  } catch {
    return { status: 'error', message: 'Could not start checkout. Please try again.' };
  }
}

export async function cancelProSubscription(): Promise<
  { status: 'scheduled'; endsAt: string | null } | { status: 'error'; message: string }
> {
  try {
    const res = await fetch('/api/razorpay/cancel', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) return { status: 'scheduled', endsAt: data.endsAt ?? null };
    return { status: 'error', message: data.error ?? 'Could not cancel. Please try again.' };
  } catch {
    return { status: 'error', message: 'Could not cancel. Please try again.' };
  }
}
