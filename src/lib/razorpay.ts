import { createHmac, timingSafeEqual } from 'node:crypto';
import { activePlanIds, validPlanId } from './billing/currency-config';

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
// Trimmed (2026-11-06 fresh-review fix): previously compared the raw,
// untrimmed env value against 'plan_' directly, which could disagree with
// currency-config.ts's validPlanId() (which does trim) for the exact same
// env var on whitespace — the two files' "is this plan id well-formed"
// checks had diverged. validPlanId() is now the single source of truth for
// that check; planId itself stays available (trimmed) as the default plan id
// createSubscription falls back to.
const planId = process.env.RAZORPAY_PRO_PLAN_ID?.trim();
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

const API_BASE = 'https://api.razorpay.com/v1';

export const isRazorpayConfigured = Boolean(
  keyId &&
    /^rzp_(test|live)_/.test(keyId) &&
    keySecret &&
    keySecret.length > 0 &&
    validPlanId(planId)
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

/** The subset of Razorpay's Payment entity billing_transactions needs (migration
 *  043). Present on `payload.payment.entity` for most subscription/payment
 *  webhook events (subscription.charged, payment.captured, payment.failed,
 *  etc.) — never fetched separately; whatever the signed webhook body itself
 *  reports is trusted as-is here, same trust anchor as the rest of this file.
 *  `amount` is already Razorpay's own integer minor units (paise/cents) —
 *  never recomputed. `status` values (created/authorized/captured/failed/
 *  refunded) match billing_transactions' CHECK constraint exactly. */
export interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

/** The subset of Razorpay's Refund entity billing_transactions needs
 *  (2026-11-07 round-3 review fix, P1 items 1+2). Present on
 *  `payload.refund.entity` for `refund.created`/`refund.processed`/
 *  `refund.failed` — a DISTINCT entity from the parent payment, with its own
 *  id and its own amount (the amount of THIS refund, never the parent
 *  payment's total amount — a payment can have multiple partial refunds,
 *  each a separate Refund entity). `payment_id` is the refund's own claim of
 *  which payment it refunds — the authoritative association, preferred over
 *  reading `payload.payment.entity.id` for this purpose. */
export interface RazorpayRefundEntity {
  id: string;
  amount: number;
  currency: string;
  payment_id: string;
  status: string;
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

export type SubscriptionReuseAction = 'reuse_unpaid' | 'blocked_live_mandate' | 'replace';

/**
 * What /api/razorpay/subscription should do with a profile's existing stored
 * subscription when a NEW checkout request resolves to `resolvedPlanId`.
 * Pure decision logic — no I/O — so it is unit-testable without real
 * Razorpay/Supabase infra (test/razorpay-subscription-reuse-suite.ts).
 *
 * 2026-11-06 review fix (requirement #1): an unpaid ('created') subscription
 * is reused only when it is ALREADY on the plan this request resolved to —
 * `isProPlanSubscription`'s multi-currency recognition means "existing is one
 * of OUR plans" is no longer the same question as "existing is on the
 * currency THIS request asked for", and conflating them let a stale
 * subscription in one currency silently override an explicit request for a
 * different one. A LIVE mandate (authenticated/active/pending) always blocks
 * creating a second subscription, regardless of currency — two live mandates
 * for one customer risk a double charge no matter what currency either is in.
 */
export function decideSubscriptionReuse(
  existing: Pick<RazorpaySubscription, 'status' | 'plan_id'>,
  resolvedPlanId: string
): SubscriptionReuseAction {
  if (existing.status === 'created') {
    return existing.plan_id === resolvedPlanId ? 'reuse_unpaid' : 'replace';
  }
  if (hasLiveMandate(existing.status)) return 'blocked_live_mandate';
  return 'replace';
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

export function createSubscription(params: { userId: string; planId?: string }): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>('POST', '/subscriptions', {
    // Caller passes a currency-resolved plan id (see resolvePlan in
    // billing/currency-config.ts) when one is known; defaults to the base
    // INR plan, same as before currency selection existed.
    plan_id: params.planId ?? planId,
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

/** True when the subscription is on one of OUR configured Pro plans (the base
 *  INR plan, or any currency's plan this process has ever seen configured —
 *  never some unrelated plan on the same Razorpay account).
 *
 *  2026-11-06 review fix (Altitude finding): this used to ALSO compare
 *  against the module-level `planId` constant directly, a second,
 *  independently-read source of "is this the INR plan" that could disagree
 *  with `activePlanIds()` (e.g. on untrimmed whitespace) and that masked
 *  rather than fixed the real issue. `activePlanIds()` is now the single
 *  source of truth — it already includes the INR plan id (it scans every
 *  currency in PLAN_ENV_VAR_BY_CURRENCY, INR included) and is historical, so
 *  there is nothing left for a second equality check to add.
 *
 *  KNOWN, NOT-FULLY-CLOSED LIMITATION (2026-11-06 fresh review finding,
 *  named rather than papered over): `activePlanIds()` is historical only
 *  within ONE process's lifetime — it comes back empty after a restart
 *  (every Railway deploy). A currency rotated out shortly before a redeploy,
 *  while a subscription on it is still live, would not be recognized here by
 *  the next process, reopening the double-mandate/dropped-orphan risk this
 *  function exists to prevent. An earlier attempt at a fix treated a
 *  well-formed `notes.userId` as sufficient evidence alone — that is UNSOUND
 *  and was reverted: it also recognized a subscription on an unrelated plan
 *  on this account as "ours" whenever that subscription happened to carry a
 *  user-id-shaped `notes.userId` (caught by the existing F3.2 regression
 *  test — "a payment on a plan that is not ours is never written to the
 *  ledger" — which started failing). `activePlanIds()` is therefore kept as
 *  the SOLE check; the restart gap stays open. The real fix needs a durable
 *  (plan_id → currency, is-ours) record outside process memory — e.g. in the
 *  database, written at subscription-creation time — which is a schema
 *  change deliberately left for a separate, future pass rather than rushed
 *  here. */
export function isProPlanSubscription(sub: RazorpaySubscription): boolean {
  return isRazorpayConfigured && activePlanIds().has(sub.plan_id);
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
