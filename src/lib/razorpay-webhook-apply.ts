import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchSubscription as fetchSubscriptionFromRazorpay,
  isProPlanSubscription,
  orphanDecision,
  planTierForSubscription,
  RazorpayApiError,
  subscriptionUserId,
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

export interface ApplyDeps {
  fetchSubscription?: (id: string) => Promise<RazorpaySubscription>;
  /** Test seam only: runs after the read and decision, immediately before the conditional write. */
  beforeWrite?: (path: 'holder' | 'orphan', attempt: number) => Promise<void>;
  /** Writes a ledger row idempotently (existing row = success). Overridable so tests can force a failure. */
  recordLedgerRow?: (row: LedgerRow) => Promise<{ error: unknown }>;
}

function defaultLedgerWriter(admin: SupabaseClient) {
  return async (row: LedgerRow) => {
    const { error } = await admin
      .from('razorpay_webhook_events')
      .upsert(row, { onConflict: 'event_id', ignoreDuplicates: true });
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
  event: { eventId: string | null; eventType: string; subscription: RazorpaySubscription | null },
  deps: ApplyDeps = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recordLedgerRow = deps.recordLedgerRow ?? defaultLedgerWriter(admin);
  let reconcile = false;

  if (event.subscription) {
    const outcome = await applySubscriptionToProfiles(admin, event.subscription, deps);
    if (outcome.kind === 'error') return { status: 500, body: { error: 'Could not apply event' } };
    if (outcome.kind === 'retry_later') return { status: outcome.status, body: { error: outcome.reason } };
    reconcile = outcome.kind === 'reconcile';
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
