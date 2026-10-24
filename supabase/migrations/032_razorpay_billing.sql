-- ==============================================================================
-- RemoteMatch — 032: Razorpay billing (Pro subscription, ₹499/month)
--
-- Razorpay replaces Stripe as the payment path (Stripe cannot onboard a new
-- Indian business; its code and stripe_* columns stay, dormant). Entitlement
-- itself does NOT change: profiles.plan_tier stays the single source the quota
-- RPCs (migration 003) read. Razorpay only becomes a new server-side writer of it.
-- Plan: docs/razorpay-integration-plan.md (Gate 1).
--
-- 1. profiles.razorpay_* — written ONLY by the service-role client
--    (/api/razorpay/{subscription,verify,webhook,cancel}). No column-level
--    UPDATE grant is added: migration 003 revoked table-wide UPDATE from
--    anon/authenticated and granted it back for five safe columns only, so new
--    columns are owner-read-only by construction, same as stripe_*.
--    The partial unique index makes a subscription id map to exactly one profile,
--    which the webhook relies on (it resolves the user by subscription id, never
--    by a body-supplied user id).
--
-- 2. razorpay_webhook_events — idempotency ledger keyed on Razorpay's
--    X-Razorpay-Event-Id header, so a redelivered webhook is a no-op. Holds no
--    payment or personal data. Same service-role-only RLS shape as
--    012/013/026/029/031.
--
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS), DDL only, no data.
-- No dependency on 030 or 031.
-- ==============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS razorpay_customer_id         text,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id     text,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_status text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_razorpay_subscription_id
  ON profiles(razorpay_subscription_id)
  WHERE razorpay_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  event_id     text PRIMARY KEY,           -- X-Razorpay-Event-Id
  event_type   text NOT NULL,              -- e.g. 'subscription.charged'
  received_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE razorpay_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS razorpay_webhook_events_service_role_all ON razorpay_webhook_events;
CREATE POLICY razorpay_webhook_events_service_role_all ON razorpay_webhook_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON razorpay_webhook_events FROM anon, authenticated;
GRANT ALL ON razorpay_webhook_events TO service_role;

-- ==============================================================================
-- DOWN (documented, not executed):
--   DROP TABLE IF EXISTS razorpay_webhook_events;
--   DROP INDEX IF EXISTS idx_profiles_razorpay_subscription_id;
--   ALTER TABLE profiles
--     DROP COLUMN IF EXISTS razorpay_subscription_status,
--     DROP COLUMN IF EXISTS razorpay_subscription_id,
--     DROP COLUMN IF EXISTS razorpay_customer_id;
--   -- Loses the user ↔ subscription binding: webhooks could no longer downgrade
--   -- a cancelled subscriber. Only safe while no real Razorpay subscription exists.
-- ==============================================================================
