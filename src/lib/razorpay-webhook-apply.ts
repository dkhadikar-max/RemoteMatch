import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchSubscription as fetchSubscriptionFromRazorpay,
  isProPlanSubscription,
  orphanDecision,
  planTierForSubscription,
  RazorpayApiError,
  subscriptionUserId,
  type RazorpayPaymentEntity,
  type RazorpayRefundEntity,
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
/** Sentinel for "this row is a payment snapshot, not a refund record" — see
 *  BillingTransactionRow's doc comment. Never a real Razorpay refund id
 *  (those are always `rfnd_...`). */
const NOT_A_REFUND = '';

/**
 * The row's idempotency key (migration 043) is the composite
 * (razorpay_payment_id, status, razorpay_refund_id) — 2026-11-07 round-3
 * review fix (P1 items 1+2), correcting the prior round's
 * (razorpay_payment_id, status)-keyed design.
 *
 * History of this key, each fix correcting the previous one's new bug:
 *  1. razorpay_payment_id alone → a later event (e.g. a refund) overwrote
 *     its capture row in place, losing the capture from history.
 *  2. razorpay_event_id alone → fixed #1, but the SAME real capture is
 *     reported on TWO separate deliveries (`subscription.charged` AND
 *     `payment.captured`), each with its own event id — wrote the same
 *     capture twice (double-counted revenue).
 *  3. (razorpay_payment_id, status) → fixed #2 (both deliveries share the
 *     same status, so they collapse), but a payment can have MULTIPLE
 *     PARTIAL REFUNDS, and Razorpay's refund-event payment snapshot often
 *     still reports status 'captured' (not 'refunded') for a partial
 *     refund — so a second partial refund on an already-refunded-once
 *     payment would silently overwrite the FIRST refund's row, because both
 *     shared the same (payment_id, status) pair. Multiple distinct refunds
 *     must never collapse into one.
 *
 * The fix: a refund is recorded under its OWN refund id (`rfnd_...`, always
 * globally unique and distinct per refund), not the parent payment's status.
 * `razorpay_refund_id` is `NOT_A_REFUND` ('') for an ordinary payment
 * snapshot row (capture/failure — unique per (payment_id, status), as
 * before) and the refund's own id for a refund row (effectively unique on
 * its own, since refund ids never collide across payments) — a single flat,
 * non-partial 3-column UNIQUE constraint handles both cases without needing
 * Postgres partial-index `ON CONFLICT` support (which `.upsert()`'s
 * `onConflict` column-list form cannot express). Redelivery of the SAME
 * refund event (same refund id) still upserts idempotently onto its own row;
 * a DIFFERENT refund on the same payment gets its own distinct row.
 */
type BillingTransactionRow = {
  profile_id: string;
  razorpay_payment_id: string;
  razorpay_refund_id: string;
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
    // onConflict is the composite (razorpay_payment_id, status,
    // razorpay_refund_id) — see BillingTransactionRow's doc comment above.
    const { error } = await admin
      .from('billing_transactions')
      .upsert(row, { onConflict: 'razorpay_payment_id,status,razorpay_refund_id' });
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
    /** payload.refund.entity, when the event carries one (2026-11-07
     *  round-3 review fix, P1 items 1+2) — a DISTINCT entity from `payment`,
     *  with its own id/amount. When present, takes priority over `payment`
     *  for the ledger write: a refund event's own refund-specific row is
     *  written, not an extra payment-snapshot row for the unchanged parent
     *  payment. */
    refund?: RazorpayRefundEntity | null;
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
  const isSubscriptionLifecycleEvent = event.eventType.startsWith('subscription.');
  if (event.subscription && isSubscriptionLifecycleEvent) {
    const outcome = await applySubscriptionToProfiles(admin, event.subscription, deps);
    if (outcome.kind === 'error') return { status: 500, body: { error: 'Could not apply event' } };
    if (outcome.kind === 'retry_later') return { status: outcome.status, body: { error: outcome.reason } };
    reconcile = outcome.kind === 'reconcile';
  }

  // Persist the billing row before marking the webhook event handled. If this
  // write fails, leaving the event unrecorded lets Razorpay retry; otherwise a
  // successful event record would make the next delivery short-circuit and
  // permanently lose the financial row. Entitlement application above is idempotent.
  if (ledgerRow) {
    const billingTxResult = await recordBillingTransaction(ledgerRow);
    if (billingTxResult.error) {
      console.error('[razorpay][ledger] FAILED to record billing_transactions row; event left unhandled for retry', {
        razorpay_payment_id: ledgerRow.razorpay_payment_id,
        razorpay_refund_id: ledgerRow.razorpay_refund_id || null,
        razorpay_subscription_id: ledgerRow.razorpay_subscription_id,
        profile_id: ledgerRow.profile_id,
        amount_minor: ledgerRow.amount_minor,
        currency: ledgerRow.currency,
        status: ledgerRow.status,
        razorpay_event_id: ledgerRow.razorpay_event_id,
        error: billingTxResult.error,
      });
      return { status: 503, body: { error: 'Could not record billing transaction; retry later' } };
    }
  }

  // Mark the event handled only after the financial row is durable.
  if (event.eventId) {
    const eventRecordResult = await recordLedgerRow({
      event_id: event.eventId,
      event_type: event.eventType || 'unknown',
    });
    if (eventRecordResult.error) {
      return { status: 503, body: { error: 'Could not record event; retry later' } };
    }
  }

  return { status: 200, body: reconcile ? { received: true, reconcile: true } : { received: true } };
}
