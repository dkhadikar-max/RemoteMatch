import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchSubscription as fetchSubscriptionFromRazorpay,
  isProPlanSubscription,
  orphanDecision,
  planTierForSubscription,
  RazorpayApiError,
  subscriptionUserId,
  type RazorpayPaymentEntity,
  type RazorpaySubscription,
} from '@/lib/razorpay';
import { isActiveClaim, writeProfileIfUnchanged } from '@/lib/razorpay-claim';

/**
 * Applies one webhook's subscription state to the profile it belongs to.
 * Called by /api/razorpay/webhook after the signature check and the live
 * re-read of the subscription from Razorpay.
 *
 * Every profile write is a compare-and-swap (writeProfileIfUnchanged) on the
 * subscription id AND razorpay_subscription_status exactly as read, so a
 * checkout claim taken between this read and the write is never overwritten.
 * On a lost compare-and-swap the WHOLE decision is re-made from a fresh read —
 * holder lookup, claim check, stored-subscription fetch, orphan decision — up
 * to MAX_ATTEMPTS; the stale write is never simply re-sent. If it still cannot
 * be applied safely, the outcome is 'retry_later' (the route answers 503 and
 * does not record the event, so Razorpay redelivers).
 */

export const MAX_ATTEMPTS = 3;

export type ApplyOutcome =
  | { kind: 'applied' } // holder updated
  | { kind: 'bound' } // paid orphan attached to its notes.userId profile
  | { kind: 'skipped_claim' } // holder is mid-checkout-claim; left untouched
  | { kind: 'reconcile'; storedId: string } // duplicate live mandate recorded for a human
  | { kind: 'ignored' } // nothing to do (unpaid / other plan / no such profile)
  | { kind: 'retry_later'; status: 502 | 503; reason: string }
  | { kind: 'error' };

type LedgerRow = { event_id: string; event_type: string };
/** razorpay_event_id is the row's idempotency key (migration 043 — 2026-11-06
 *  review fix, requirement #5): a payment gets ONE row per webhook event it
 *  appears on (a capture, then later a separate refund, are different rows),
 *  not one row per payment that later events overwrite in place. It is typed
 *  nullable here only because the field is technically optional on the wire;
 *  in practice Razorpay always sends X-Razorpay-Event-Id, and a delivery
 *  that somehow lacks one simply fails this best-effort write (logged, never
 *  fatal — same as any other ledger-write failure). */
type BillingTransactionRow = {
  profile_id: string;
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  razorpay_event_id: string | null;
};

export interface ApplyDeps {
  fetchSubscription?: (id: string) => Promise<RazorpaySubscription>;
  /** Test seam only: runs after the read and decision, immediately before the conditional write. */
  beforeWrite?: (path: 'holder' | 'orphan', attempt: number) => Promise<void>;
  /** Writes a ledger row idempotently (existing row = success). Overridable so tests can force a failure. */
  recordLedgerRow?: (row: LedgerRow) => Promise<{ error: unknown }>;
  /** Writes/updates a billing_transactions row (migration 043), keyed on the
   *  payment id so redelivery updates status rather than duplicating. Never
   *  blocks the primary entitlement flow — a failure here is logged, not
   *  surfaced as a webhook failure (Razorpay must not be made to redeliver
   *  just because the secondary ledger write failed). Overridable for tests. */
  recordBillingTransaction?: (row: BillingTransactionRow) => Promise<{ error: unknown }>;
}

function defaultLedgerWriter(admin: SupabaseClient) {
  return async (row: LedgerRow) => {
    const { error } = await admin
      .from('razorpay_webhook_events')
      .upsert(row, { onConflict: 'event_id', ignoreDuplicates: true });
    return { error };
  };
}

function defaultBillingTransactionWriter(admin: SupabaseClient) {
  return async (row: BillingTransactionRow) => {
    // onConflict is razorpay_event_id, not razorpay_payment_id (2026-11-06
    // review fix, requirement #5) — see BillingTransactionRow's doc comment
    // above. Keying on the payment id alone meant a refund event for an
    // already-captured payment overwrote the capture row in place instead of
    // adding a new one, losing the original capture from history.
    const { error } = await admin
      .from('billing_transactions')
      .upsert(row, { onConflict: 'razorpay_event_id' });
    return { error };
  };
}

export async function applySubscriptionToProfiles(
  admin: SupabaseClient,
  subscription: RazorpaySubscription,
  deps: ApplyDeps = {}
): Promise<ApplyOutcome> {
  const fetchSub = deps.fetchSubscription ?? fetchSubscriptionFromRazorpay;
  const recordLedgerRow = deps.recordLedgerRow ?? defaultLedgerWriter(admin);
  const fields = {
    plan_tier: planTierForSubscription(subscription),
    razorpay_customer_id: subscription.customer_id ?? null,
    razorpay_subscription_status: subscription.status,
    updated_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: holder, error: holderError } = await admin
      .from('profiles')
      .select('id, razorpay_subscription_id, razorpay_subscription_status')
      .eq('razorpay_subscription_id', subscription.id)
      .maybeSingle();
    if (holderError) return { kind: 'error' };

    if (holder) {
      // A holder mid-claim is replacing this (ended) subscription and is Free
      // by construction: leave the claim alone.
      if (isActiveClaim(holder.razorpay_subscription_status)) return { kind: 'skipped_claim' };
      await deps.beforeWrite?.('holder', attempt);
      const result = await writeProfileIfUnchanged(
        admin,
        holder.id,
        { subscriptionId: subscription.id, status: holder.razorpay_subscription_status },
        fields
      );
      if (result === 'written') return { kind: 'applied' };
      if (result === 'error') return { kind: 'error' };
      continue; // conflict / claimed: re-read and re-decide
    }

    // Orphan: no profile holds this subscription.
    const targetId = subscriptionUserId(subscription);
    if (!targetId || !isProPlanSubscription(subscription) || fields.plan_tier !== 'pro') return { kind: 'ignored' };

    const { data: target, error: targetError } = await admin
      .from('profiles')
      .select('id, razorpay_subscription_id, razorpay_subscription_status')
      .eq('id', targetId)
      .maybeSingle();
    if (targetError) return { kind: 'error' };
    if (!target) return { kind: 'ignored' };
    if (isActiveClaim(target.razorpay_subscription_status)) {
      return { kind: 'retry_later', status: 503, reason: 'Profile is mid-checkout; retry later' };
    }

    const storedId: string | null = target.razorpay_subscription_id;
    let stored: RazorpaySubscription | null = null;
    if (storedId) {
      try {
        stored = await fetchSub(storedId);
      } catch (err) {
        const status = err instanceof RazorpayApiError ? err.status : 0;
        if (status !== 400 && status !== 404) {
          return { kind: 'retry_later', status: 502, reason: 'Could not read stored subscription' };
        }
        // Unknown to Razorpay: holds nothing that can charge.
      }
    }

    const decision = orphanDecision(subscription, stored);
    if (decision === 'ignore') return { kind: 'ignored' };
    if (decision === 'reconcile') {
      // The reconcile row IS the outcome here, so it must be durably written
      // before the event can count as handled. On failure: retryable, so the
      // route does not record the event and Razorpay redelivers. Idempotent:
      // an already-existing row is not an error (ignoreDuplicates).
      const { error } = await recordLedgerRow({
        event_id: `reconcile:${subscription.id}:${storedId}`,
        event_type: 'reconcile.duplicate_live_mandate',
      });
      if (error) {
        return { kind: 'retry_later', status: 503, reason: 'Could not record reconciliation; retry later' };
      }
      console.error('[razorpay][RECONCILE] paid subscription', subscription.id, 'not bound: profile already holds live mandate', storedId);
      return { kind: 'reconcile', storedId: storedId! };
    }

    await deps.beforeWrite?.('orphan', attempt);
    const result = await writeProfileIfUnchanged(
      admin,
      target.id,
      { subscriptionId: storedId, status: target.razorpay_subscription_status },
      { ...fields, razorpay_subscription_id: subscription.id }
    );
    if (result === 'written') {
      console.warn('[razorpay] bound paid orphan subscription to its notes.userId profile', subscription.id);
      return { kind: 'bound' };
    }
    if (result === 'error') return { kind: 'error' };
    // conflict / claimed: re-read and re-decide
  }

  return { kind: 'retry_later', status: 503, reason: 'Profile kept changing; retry later' };
}

/**
 * Everything /api/razorpay/webhook does after the signature check, the
 * duplicate-event check and the live re-read of the subscription: apply it,
 * then record the event as handled ONLY if the apply succeeded. Any non-2xx
 * outcome leaves the event unrecorded so Razorpay redelivers it. `subscription`
 * is null for event types that carry no subscription (acknowledged, recorded).
 */
export async function processWebhookEvent(
  admin: SupabaseClient,
  event: {
    eventId: string | null;
    eventType: string;
    subscription: RazorpaySubscription | null;
    /** payload.payment.entity, when the event carries one. Independent of
     *  `subscription` being applicable — a payment can arrive on an event
     *  whose subscription apply was 'ignored' (not ours), in which case the
     *  ownership check below skips the ledger write too. */
    payment?: RazorpayPaymentEntity | null;
  },
  deps: ApplyDeps = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recordLedgerRow = deps.recordLedgerRow ?? defaultLedgerWriter(admin);
  const recordBillingTransaction = deps.recordBillingTransaction ?? defaultBillingTransactionWriter(admin);
  let reconcile = false;

  // Only subscription LIFECYCLE events (subscription.*) drive the entitlement
  // apply/reconcile state machine. 2026-11-06 review fix (requirement #2):
  // the G1 fix resolves a subscription id for payment.*/refund.* events too
  // (needed below, for ledger attribution), but those events are NOT
  // subscription state changes — every renewal already fires BOTH
  // subscription.charged (which must apply) and payment.captured (which must
  // not re-apply the same thing a second time). Re-running the full apply
  // pipeline for the payment-level event as well doubled DB writes per cycle
  // and turned a transient fetch failure on an otherwise-inconsequential
  // payment.failed/refund.created into a 502 that forces Razorpay into a
  // redelivery loop for what should be a trivial acknowledgement.
  if (event.subscription && event.eventType.startsWith('subscription.')) {
    const outcome = await applySubscriptionToProfiles(admin, event.subscription, deps);
    if (outcome.kind === 'error') return { status: 500, body: { error: 'Could not apply event' } };
    if (outcome.kind === 'retry_later') return { status: outcome.status, body: { error: outcome.reason } };
    reconcile = outcome.kind === 'reconcile';
  }

  // billing_transactions (migration 043): best-effort, never blocks or fails
  // the webhook response — a ledger-write problem must not make Razorpay
  // redeliver an otherwise-successfully-applied entitlement event. Only
  // written when the payment is tied to one of OUR Pro plans and bound to a
  // real profile (notes.userId) — never for an unrelated plan on the account.
  if (event.payment && event.subscription) {
    const profileId = subscriptionUserId(event.subscription);
    if (profileId && isProPlanSubscription(event.subscription)) {
      const ledgerRow = {
        profile_id: profileId,
        razorpay_payment_id: event.payment.id,
        razorpay_subscription_id: event.subscription.id,
        amount_minor: event.payment.amount,
        currency: event.payment.currency,
        status: event.payment.status,
        razorpay_event_id: event.eventId,
      };
      const { error } = await recordBillingTransaction(ledgerRow);
      if (error) {
        // Non-fatal (see above), but must carry everything needed to
        // reconcile the missing row by hand later: the payment id above all
        // (that's the actual financial record this failed to capture), plus
        // enough context to re-derive the row without re-deriving it from
        // scratch. Webhook redelivery safely retries this same upsert — it's
        // idempotent on razorpay_payment_id — so a transient failure here
        // self-heals on the next delivery; this log is for the case it doesn't.
        console.error('[razorpay][ledger] FAILED to record billing_transactions row (non-fatal to entitlement, but NOT silently treated as success)', {
          razorpay_payment_id: ledgerRow.razorpay_payment_id,
          razorpay_subscription_id: ledgerRow.razorpay_subscription_id,
          profile_id: ledgerRow.profile_id,
          amount_minor: ledgerRow.amount_minor,
          currency: ledgerRow.currency,
          status: ledgerRow.status,
          razorpay_event_id: ledgerRow.razorpay_event_id,
          error,
        });
      }
    }
  }

  if (event.eventId) {
    // A concurrent duplicate may have inserted first — the apply above is
    // idempotent, so an existing row is fine. A real failure to record is
    // retryable rather than acknowledged.
    const { error } = await recordLedgerRow({ event_id: event.eventId, event_type: event.eventType || 'unknown' });
    if (error) return { status: 503, body: { error: 'Could not record event; retry later' } };
  }

  return { status: 200, body: reconcile ? { received: true, reconcile: true } : { received: true } };
}
