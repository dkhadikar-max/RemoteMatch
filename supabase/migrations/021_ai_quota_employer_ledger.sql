-- ==============================================================================
-- RemoteMatch — 021: C5 per-employer Gemini soft cap (AI Phase 1A)
--
-- docs/ai-phase1-implementation-plan.md §2/§3, locked decision §11.5: one
-- Gemini-heavy employer must not be able to consume the whole shared daily
-- inventory (ai_quota_ledger, migration 020) by itself. This is bookkeeping
-- for a SOFT cap, not a second scarce resource requiring its own
-- reserve/consume/refund cycle — the real authorization gate stays
-- ai_quota_ledger's reserve_gemini_request(); this table only decides
-- whether that gate is even attempted for a given employer on a given day.
-- No RPC is defined here deliberately (per spec §3): the TypeScript wrapper
-- (src/lib/ai/quota-ledger.ts) does a plain SELECT (soft-cap check, no lock
-- needed — a race here can only ever under-count by one request, never
-- over-spend the real global budget, which is still protected by 020's
-- row-locked RPC) and a plain `INSERT ... ON CONFLICT DO UPDATE` increment,
-- both via the service-role client.
--
-- employer_id is a real FK to allowlist_employers(id) (migration 012's
-- uuid PK) — NOT a loose text field, so an employer row deletion cleanly
-- cascades rather than leaving orphaned quota rows.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS ai_quota_employer_ledger (
  provider       text NOT NULL DEFAULT 'gemini',
  employer_id    uuid NOT NULL REFERENCES allowlist_employers(id) ON DELETE CASCADE,
  usage_date     date NOT NULL,
  requests_used  int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, employer_id, usage_date)
);

COMMENT ON TABLE ai_quota_employer_ledger IS
  'Per-employer daily count of real Gemini requests attributed to that '
  'employer''s C5 extraction, used only as a soft-cap READ before '
  'reserve_gemini_request() is even attempted (migration 020). Incremented '
  'in lockstep with ai_quota_ledger.requests_used at the same call site, '
  'same "any outcome counts" rule.';

ALTER TABLE ai_quota_employer_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quota_employer_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_quota_employer_ledger_service_role_all" ON ai_quota_employer_ledger FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON ai_quota_employer_ledger FROM anon, authenticated;
GRANT ALL ON ai_quota_employer_ledger TO service_role;

-- ==============================================================================
-- DOWN:
--   DROP TABLE IF EXISTS ai_quota_employer_ledger;
--   -- Safe at any point. If dropped while code still calls the soft-cap
--   -- check, the TypeScript wrapper treats a query error as "no employer
--   -- history found" (fail OPEN on this specific soft check only — the
--   -- real budget protection is ai_quota_ledger's row-locked RPC, which is
--   -- unaffected by this table's presence or absence).
-- ==============================================================================
