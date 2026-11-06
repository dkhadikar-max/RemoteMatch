import type { RazorpayPaymentEntity } from './razorpay';

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
}

interface RawWebhookBody {
  event?: string;
  payload?: {
    subscription?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string; amount?: number; currency?: string; status?: string; subscription_id?: string | null } };
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

  return { eventType, subscriptionId, payment };
}
