import type { RazorpayPaymentEntity, RazorpayRefundEntity } from './razorpay';

/**
 * Pure parsing of a Razorpay webhook body — no network, no DB, independently
 * unit-testable. Split out of the route handler specifically to regression-
 * test the G1 fix (2026-11-05, docs/international-payments-audit-plan-2026-10-31.md
 * §8.2) without needing a live server or a real Razorpay subscription.
 */

export interface ParsedWebhookEvent {
  eventType: string;
  /** Resolved from EITHER `payload.subscription.entity.id` (subscription.*
   *  events) OR `payload.payment.entity.subscription_id` (payment.failed,
   *  payment.captured, refund.created, etc. — separate top-level event types
   *  that carry a payment but no subscription entity of their own). Never
   *  gated on the event type string — consistent with this integration's
   *  own principle that entitlement/ledger truth comes from re-reading
   *  Razorpay's API, never from trusting what kind of event this claims to be. */
  subscriptionId: string | undefined;
  /** Only set when the entity is well-formed (all four fields present with
   *  the right types) — a partial/malformed payment entity is treated as
   *  absent, never partially trusted. */
  payment: RazorpayPaymentEntity | null;
  /**
   * `payload.refund.entity`, when present — 2026-11-07 round-3 review fix
   * (P1 items 1+2). A `refund.created`/`refund.processed`/`refund.failed`
   * webhook carries THIS as the actual refund record (its own id, its own
   * amount, which payment it refunds) ALONGSIDE `payload.payment.entity`
   * (the parent payment, whose own `status` may still read 'captured' for a
   * PARTIAL refund — never 'refunded'). Before this fix, refund events were
   * parsed by reading `payment.entity.status`, which only reports 'refunded'
   * for a FULL refund; a partial refund was silently indistinguishable from
   * an ordinary capture at the parsing layer. Same strict validation
   * invariant as `payment`: only set when every field is present with the
   * right type, never partially trusted.
   */
  refund: RazorpayRefundEntity | null;
}

interface RawWebhookBody {
  event?: string;
  payload?: {
    subscription?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string; amount?: number; currency?: string; status?: string; subscription_id?: string | null } };
    refund?: { entity?: { id?: string; amount?: number; currency?: string; payment_id?: string; status?: string } };
  };
}

export function parseWebhookEvent(rawBody: string): ParsedWebhookEvent {
  const event: RawWebhookBody = JSON.parse(rawBody);
  const eventType = typeof event.event === 'string' ? event.event : '';

  const subscriptionIdFromSubscriptionEntity = event.payload?.subscription?.entity?.id;
  const subscriptionIdFromPaymentEntity = event.payload?.payment?.entity?.subscription_id;
  const subscriptionId =
    typeof subscriptionIdFromSubscriptionEntity === 'string'
      ? subscriptionIdFromSubscriptionEntity
      : typeof subscriptionIdFromPaymentEntity === 'string'
        ? subscriptionIdFromPaymentEntity
        : undefined;

  const paymentEntity = event.payload?.payment?.entity;
  const payment: RazorpayPaymentEntity | null =
    paymentEntity &&
    typeof paymentEntity.id === 'string' &&
    typeof paymentEntity.amount === 'number' &&
    typeof paymentEntity.currency === 'string' &&
    typeof paymentEntity.status === 'string'
      ? { id: paymentEntity.id, amount: paymentEntity.amount, currency: paymentEntity.currency, status: paymentEntity.status }
      : null;

  const refundEntity = event.payload?.refund?.entity;
  const refund: RazorpayRefundEntity | null =
    refundEntity &&
    typeof refundEntity.id === 'string' &&
    typeof refundEntity.amount === 'number' &&
    typeof refundEntity.currency === 'string' &&
    typeof refundEntity.payment_id === 'string' &&
    typeof refundEntity.status === 'string'
      ? { id: refundEntity.id, amount: refundEntity.amount, currency: refundEntity.currency, payment_id: refundEntity.payment_id, status: refundEntity.status }
      : null;

  return { eventType, subscriptionId, payment, refund };
}

export type SubscriptionFetchFailureOutcome = 'retry' | 'acknowledge';

/**
 * What /api/razorpay/webhook should do when `fetchSubscription()` fails,
 * AFTER parsing the event. Pure decision logic — no I/O — so it is
 * unit-testable without a live server (2026-11-07 round-3 review fix, P2
 * item 4).
 *
 * A subscription.* event's fetch failure must always retry — entitlement
 * correctness depends on reading the subscription. A payment.* or refund.*
 * event's fetch failure may acknowledge ONLY when the event carries no
 * payment or refund entity (nothing financial would be lost by not
 * recording it). If it DOES carry one, failing to resolve the subscription
 * means the ledger row can never be attributed to a profile — and the event
 * still gets recorded as "handled" afterward (idempotency), which would
 * permanently lose that financial record with no reconciliation path. Such
 * an event must be retried instead, exactly like a lifecycle event.
 */
export function subscriptionFetchFailureOutcome(params: {
  isLifecycleEvent: boolean;
  hasPayment: boolean;
  hasRefund: boolean;
}): SubscriptionFetchFailureOutcome {
  if (params.isLifecycleEvent || params.hasPayment || params.hasRefund) return 'retry';
  return 'acknowledge';
}
