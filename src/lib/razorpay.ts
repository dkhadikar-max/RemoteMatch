import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay Subscriptions — server-only helpers for RemoteMatch Pro
 * (₹499/month, INR). Plan: docs/razorpay-integration-plan.md.
 *
 * Deliberately a thin `fetch` client over the REST API rather than the
 * `razorpay` npm SDK: four calls plus two HMAC checks don't justify a new
 * dependency. Import this ONLY from route handlers — it reads
 * RAZORPAY_KEY_SECRET, which must never reach the browser. The key id is
 * public by design (Checkout needs it) and is handed to the client by
 * /api/razorpay/subscription.
 *
 * Trust anchors, same split as the dormant Stripe integration:
 *   - Checkout handler result → verifyPaymentSignature (KEY_SECRET HMAC), then
 *     re-read the subscription from Razorpay's API before granting anything.
 *   - Webhook → verifyWebhookSignature (WEBHOOK_SECRET HMAC over the raw body).
 */

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const planId = process.env.RAZORPAY_PRO_PLAN_ID;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

const API_BASE = 'https://api.razorpay.com/v1';

export const isRazorpayConfigured = Boolean(
  keyId &&
    /^rzp_(test|live)_/.test(keyId) &&
    keySecret &&
    keySecret.length > 0 &&
    planId &&
    planId.startsWith('plan_')
);

export const isRazorpayWebhookConfigured = isRazorpayConfigured && Boolean(webhookSecret);

/** Public — safe to send to the browser. Null when Razorpay is unconfigured. */
export const razorpayKeyId = isRazorpayConfigured ? keyId! : null;

/**
 * Who may START a new Pro purchase (RAZORPAY_ALLOWLIST_USER_IDS). Gates only
 * /api/razorpay/subscription — never the webhook, /verify or /cancel, so
 * existing subscribers keep syncing while new purchases are restricted.
 * Three deliberately distinct states:
 * - variable NOT SET          → 'open': everyone (behaviour before this setting existed)
 * - SET but empty / no valid  → 'closed': nobody — an intentional kill switch;
 *   UUIDs (e.g. "", " ", ",,")  never silently falls back to open
 * - SET with user UUIDs       → 'list': only those ids (case-insensitive);
 *                               malformed entries are ignored, never widened
 */
export type PurchaseAllowlist =
  | { mode: 'open' }
  | { mode: 'closed' }
  | { mode: 'list'; userIds: ReadonlySet<string> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parsePurchaseAllowlist(raw: string | undefined): PurchaseAllowlist {
  if (raw === undefined) return { mode: 'open' };
  const userIds = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => UUID_RE.test(s))
  );
  return userIds.size === 0 ? { mode: 'closed' } : { mode: 'list', userIds };
}

export function isPurchaseAllowed(allowlist: PurchaseAllowlist, userId: string): boolean {
  if (allowlist.mode === 'open') return true;
  if (allowlist.mode === 'closed') return false;
  return allowlist.userIds.has(userId.toLowerCase());
}

export const purchaseAllowlist = parsePurchaseAllowlist(process.env.RAZORPAY_ALLOWLIST_USER_IDS);

/**
 * 5 years of monthly cycles. Razorpay requires a finite total_count, and
 * mandate (card / UPI AutoPay) validity limits make a very long horizon
 * risky to be rejected at authorization time.
 */
const TOTAL_BILLING_CYCLES = 60;

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: string;
  /** Number of successful charges so far. 0 until the first charge lands. */
  paid_count: number;
  customer_id: string | null;
  current_end: number | null;
  notes: Record<string, string> | [] | null;
}

/**
 * THE entitlement rule — the only place a Razorpay subscription is mapped to
 * a tier; /verify and the webhook both call it. It reads the whole record, not
 * just the status, because a mandate being authorised is not money collected:
 * - active                          → pro (charged and current)
 * - authenticated, paid_count >= 1  → pro
 * - authenticated, paid_count == 0  → free (mandate set up, first charge not yet in)
 * - pending, paid_count >= 1        → pro (renewal retry window after a real payment)
 * - pending, paid_count == 0        → free
 * - anything else (created, halted, cancelled, completed, expired, paused) → free
 */
export function planTierForSubscription(sub: Pick<RazorpaySubscription, 'status' | 'paid_count'>): 'pro' | 'free' {
  const paid = Number(sub.paid_count) >= 1;
  switch (sub.status) {
    case 'active':
      return 'pro';
    case 'authenticated':
    case 'pending':
      return paid ? 'pro' : 'free';
    default:
      return 'free';
  }
}

/** Statuses with a live mandate that can still charge — creating another subscription alongside would risk a double charge. */
export function hasLiveMandate(status: string): boolean {
  return status === 'authenticated' || status === 'active' || status === 'pending';
}

/**
 * What /verify should tell the browser after Checkout's handler fires.
 * 'awaiting_first_charge' is a mandate that is authorised but not yet charged:
 * not a failure — Pro arrives via the webhook when the first charge lands.
 */
export function checkoutOutcome(
  sub: Pick<RazorpaySubscription, 'status' | 'paid_count'>
): 'granted' | 'awaiting_first_charge' | 'not_paid' {
  if (planTierForSubscription(sub) === 'pro') return 'granted';
  if (hasLiveMandate(sub.status)) return 'awaiting_first_charge';
  return 'not_paid';
}

/**
 * Webhook orphan handling: a subscription no profile stores, which Razorpay
 * says is paid on our plan, bound by notes.userId to `target`.
 * - 'bind': target holds nothing, or only a subscription that can no longer
 *   charge (created/halted/cancelled/completed/expired/paused, or unknown to
 *   Razorpay) — safe to attach the paid one.
 * - 'reconcile': target already holds a different subscription with a live
 *   mandate. Two live mandates for one customer is a duplicate-charge case for
 *   a human; never silently replace the existing binding.
 * - 'ignore': the orphan itself does not grant Pro (never bound).
 */
export function orphanDecision(
  orphan: Pick<RazorpaySubscription, 'status' | 'paid_count'>,
  storedOnTarget: Pick<RazorpaySubscription, 'status'> | null
): 'bind' | 'reconcile' | 'ignore' {
  if (planTierForSubscription(orphan) !== 'pro') return 'ignore';
  if (storedOnTarget && hasLiveMandate(storedOnTarget.status)) return 'reconcile';
  return 'bind';
}

export class RazorpayApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

async function razorpayRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!isRazorpayConfigured) throw new RazorpayApiError(503, 'Razorpay not configured');
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    // Razorpay's error.description never contains credentials; safe to surface to logs.
    throw new RazorpayApiError(res.status, json?.error?.description ?? `Razorpay ${res.status}`);
  }
  return json as T;
}

export function createSubscription(params: { userId: string }): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>('POST', '/subscriptions', {
    plan_id: planId,
    total_count: TOTAL_BILLING_CYCLES,
    quantity: 1,
    customer_notify: 1,
    // Razorpay-native binding of the subscription to our user id — re-checked
    // in /verify so a subscription can never be redeemed by another account.
    notes: { userId: params.userId },
  });
}

export function fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    return Promise.reject(new RazorpayApiError(400, 'Invalid subscription id'));
  }
  return razorpayRequest<RazorpaySubscription>('GET', `/subscriptions/${subscriptionId}`);
}

export function cancelSubscriptionAtCycleEnd(subscriptionId: string): Promise<RazorpaySubscription> {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    return Promise.reject(new RazorpayApiError(400, 'Invalid subscription id'));
  }
  return razorpayRequest<RazorpaySubscription>('POST', `/subscriptions/${subscriptionId}/cancel`, {
    cancel_at_cycle_end: true,
  });
}

/** True when the subscription is on the configured Pro plan (not some other plan on the account). */
export function isProPlanSubscription(sub: RazorpaySubscription): boolean {
  return isRazorpayConfigured && sub.plan_id === planId;
}

/** The user id we bound at creation time, or null if absent/malformed. */
export function subscriptionUserId(sub: RazorpaySubscription): string | null {
  const notes = sub.notes;
  if (!notes || Array.isArray(notes)) return null; // Razorpay serializes empty notes as []
  return typeof notes.userId === 'string' ? notes.userId : null;
}

function hmacHexEquals(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout handler signature for subscriptions: HMAC(payment_id + "|" + subscription_id, KEY_SECRET). */
export function verifyPaymentSignature(params: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
}): boolean {
  if (!isRazorpayConfigured) return false;
  return hmacHexEquals(`${params.paymentId}|${params.subscriptionId}`, keySecret!, params.signature);
}

/** Webhook signature: HMAC(raw request body, WEBHOOK_SECRET). */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!isRazorpayWebhookConfigured) return false;
  return hmacHexEquals(rawBody, webhookSecret!, signature);
}
