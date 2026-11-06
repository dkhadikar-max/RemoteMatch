-- ==============================================================================
-- RemoteMatch — 043: billing_transactions (per-payment ledger)
--
-- Renumbered 036 → 043 on 2026-11-05: migrations 036–042 are owned by PR #48
-- (employer-company/Resume Intelligence), 044 is the employer-company
-- workstream's own migration — see docs/international-payments-audit-plan-
-- 2026-10-31.md §5 and docs/direct-employer-supply-phase1-audit-2026-11-05.md
-- for the full 3-way coordination record. Pure renumber, no content change.
--
-- NOT APPLIED anywhere as of writing (local file only — see
-- docs/international-payments-audit-plan-2026-10-31.md). Written ahead of
-- time because it's needed regardless of which currency-expansion option is
-- chosen, but running it against any database (local, isolated-test, or
-- production) requires separate explicit authorization, same as every other
-- migration in this project.
--
-- Today (migration 032) there is NO record of individual charges anywhere —
-- only the subscription's current id/status on profiles. This table adds
-- that missing ledger: one row per Razorpay WEBHOOK EVENT that carries a
-- payment (checkout success, webhook charge, failure, refund), independent
-- of entitlement logic, which keeps reading profiles.plan_tier exactly as it
-- does today. Never the source of truth for entitlement —
-- razorpay.ts's planTierForSubscription stays that.
--
-- amount_minor is the integer minor-unit amount Razorpay itself reports
-- (paise/cents/fils), never a value computed or trusted from the browser.
--
-- 2026-11-06 review fixes (first round):
-- - razorpay_order_id and country columns were dropped (requirement #7,
--   explicit decision): nothing in this PR extracts either from the webhook
--   payload — RazorpayPaymentEntity (src/lib/razorpay.ts) only carries
--   id/amount/currency/status, and Razorpay's Subscriptions API payments
--   don't carry a conventional order_id the way one-off Orders do. A
--   defined-but-always-NULL column is worse than no column; add either back
--   in a future migration alongside the parsing code that would actually
--   populate it.
--
-- 2026-11-06 FRESH review fix (second round): the first round moved
-- uniqueness from razorpay_payment_id alone to razorpay_event_id alone —
-- that fixed the original bug (a refund overwriting its capture row) but
-- introduced a new one: a single real capture is reported on TWO separate
-- webhook deliveries with two different event ids (subscription.charged AND
-- payment.captured both fire for the same renewal), so keying on event id
-- wrote the SAME capture twice. The correct key is the COMPOSITE
-- (razorpay_payment_id, status): both deliveries for the same real capture
-- share the same payment id AND the same status ('captured'), so they
-- collapse onto ONE row; a LATER status transition for that payment (e.g.
-- 'refunded') has a different composite key, so it is still a separate row —
-- history is preserved exactly as the first-round fix intended, without the
-- double-count. razorpay_event_id is a plain, nullable audit column now (not
-- a constraint) — a delivery with no X-Razorpay-Event-Id header no longer
-- risks failing a NOT NULL check on this table.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS billing_transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id             UUID REFERENCES profiles(id) ON DELETE SET NULL,
  razorpay_payment_id    TEXT NOT NULL,
  razorpay_subscription_id TEXT,
  amount_minor           BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency               TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),
  razorpay_event_id      TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (razorpay_payment_id, status)
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_profile_id ON billing_transactions(profile_id);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_subscription_id ON billing_transactions(razorpay_subscription_id);
CREATE INDEX IF NOT EXISTS idx_billing_transactions_payment_id ON billing_transactions(razorpay_payment_id);

ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_transactions_service_role_all ON billing_transactions;
CREATE POLICY billing_transactions_service_role_all ON billing_transactions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON billing_transactions FROM anon, authenticated;
GRANT ALL ON billing_transactions TO service_role;

-- ==============================================================================
-- DOWN (documented, not executed):
--   DROP TABLE IF EXISTS billing_transactions;
--   -- Safe at any time: this table is write-only history, nothing else reads
--   -- it (entitlement stays on profiles.plan_tier / razorpay_subscription_status).
-- ==============================================================================
