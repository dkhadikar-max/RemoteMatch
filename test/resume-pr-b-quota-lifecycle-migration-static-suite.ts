/**
 * Resume Intelligence (PR B) — Stage 2 static regression suite for migration
 * 040_resume_quota_lifecycle.sql.
 *
 * NOT a live-database test — no Postgres instance is started or touched. This reads the
 * migration's own SQL text and asserts on its literal shape, the same precedented technique
 * used in test/resume-acl-hardening-static-suite.ts for the ACL-hardening migration. A true
 * dynamic test of the RPCs' actual runtime behavior (idempotent increments, row locking,
 * concurrency races, RLS enforcement) requires a real or disposable Postgres instance — exactly
 * what migration 039's own live run (test/live-pg/resume-concurrency-live-suite.ts) needed, and
 * that required its own separate, explicit authorization. This suite does not assume that
 * authorization; it is the static half only, run alongside (not instead of) a future live pass.
 *
 * Run: npx tsx test/resume-pr-b-quota-lifecycle-migration-static-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: string) {
  if (condition) { console.log(`  ✓ PASS: ${message}`); passed++; }
  else { console.error(`  ✗ FAIL: ${message}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');
const sql = readFileSync(join(MIGRATIONS_DIR, '040_resume_quota_lifecycle.sql'), 'utf8');

function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — QUOTA LIFECYCLE MIGRATION 040 (static)');
  console.log('='.repeat(78));

  console.log('\n1. attempt_number column');
  {
    assert(/ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1/.test(sql),
      'resume_analyses gains attempt_number, NOT NULL, defaulted to 1');
    assert(/CHECK \(attempt_number >= 1\)/.test(sql),
      'attempt_number has a CHECK (>= 1) guard');
  }

  console.log('\n2. resume_quota_events table shape');
  {
    assert(/CREATE TABLE IF NOT EXISTS resume_quota_events/.test(sql), 'resume_quota_events table is created');
    assert(/event_type\s+text NOT NULL CHECK \(event_type IN \('reserved', 'refunded'\)\)/.test(sql),
      'event_type is constrained to exactly reserved|refunded');
    assert(/CONSTRAINT resume_quota_events_unique_attempt_event UNIQUE \(analysis_id, attempt_number, event_type\)/.test(sql),
      'the (analysis_id, attempt_number, event_type) UNIQUE constraint exists — the actual idempotency backstop');
    assert(/analysis_id\s+uuid NOT NULL REFERENCES resume_analyses\(id\) ON DELETE CASCADE/.test(sql),
      'analysis_id cascades on delete, matching the existing resume_analyses→resume_versions→profiles cascade chain — found via Stage 3 live validation: without this, deleting an account/resume-version would start failing (FK violation) the moment any analysis ever reached quota reservation');
    assert(/CONSTRAINT resume_quota_events_reason_shape CHECK/.test(sql) && /event_type = 'reserved' AND reason IS NULL/.test(sql) && /event_type = 'refunded' AND reason IS NOT NULL AND reason <> ''/.test(sql),
      'a reserved event always has a NULL reason, a refunded event always has a non-empty one');
  }

  console.log('\n3. resume_quota_events lockdown (RLS, same discipline as ai_call_events)');
  {
    assert(/ALTER TABLE resume_quota_events ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS enabled on resume_quota_events');
    assert(/ALTER TABLE resume_quota_events FORCE ROW LEVEL SECURITY/.test(sql), 'RLS forced on resume_quota_events (applies even to the table owner)');
    assert(/USING \(auth\.role\(\) = 'service_role'\)/.test(sql) && /WITH CHECK \(auth\.role\(\) = 'service_role'\)/.test(sql),
      'the only policy restricts all access to service_role');
    assert(/REVOKE ALL ON resume_quota_events FROM PUBLIC, anon, authenticated/.test(sql),
      'no client role (PUBLIC/anon/authenticated) is granted direct table access — writes only via the SECURITY DEFINER RPCs');
  }

  console.log('\n4. upsert_resume_analysis() — widened return shape, scoped increment');
  {
    assert(/DROP FUNCTION IF EXISTS public\.upsert_resume_analysis\(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric\)/.test(sql),
      'the old 2-column-return signature is dropped before recreating with a wider RETURNS TABLE (CREATE OR REPLACE cannot change a return shape)');
    assert(/RETURNS TABLE \(id UUID, wrote BOOLEAN, attempt_number INT\)/.test(sql),
      'RETURNS TABLE is widened to carry attempt_number back to the caller');

    const doUpdateMatch = sql.match(/ON CONFLICT \([^)]*\) DO UPDATE SET([\s\S]*?)WHERE NOT \(/);
    assert(!!doUpdateMatch, 'the DO UPDATE SET clause is present and followed by the rejection WHERE guard');
    const doUpdateBody = doUpdateMatch?.[1] ?? '';
    assert(/attempt_number\s*=\s*resume_analyses\.attempt_number \+ 1/.test(doUpdateBody),
      'the DO UPDATE (a successful reclaim) increments attempt_number by exactly 1');
    assert(/created_at\s*=\s*now\(\)/.test(doUpdateBody),
      'the DO UPDATE refreshes created_at on a successful reclaim (bundled per the spec)');

    const insertValuesMatch = sql.match(/INSERT INTO resume_analyses \([\s\S]*?\)\s*VALUES\s*\(([\s\S]*?)\)\s*\n\s*ON CONFLICT/);
    assert(!!insertValuesMatch, 'the fresh-row INSERT VALUES clause is present');
    assert(/,\s*1\s*\)?\s*$/.test((insertValuesMatch?.[1] ?? '').trim()) || /,\s*1\s*$/.test((insertValuesMatch?.[1] ?? '').trim()),
      'a brand-new key is inserted with attempt_number = 1 (the VALUES list ends with the literal 1)',
      `VALUES tail: ${(insertValuesMatch?.[1] ?? '').slice(-30)}`);

    // The two existing rejection early-returns must report the EXISTING attempt_number
    // unchanged, never increment it, and never write anything.
    const rejection1 = sql.match(/A prior success is never clobbered[\s\S]*?RETURN QUERY SELECT v_existing\.id, false, v_existing\.attempt_number;/);
    assert(!!rejection1, 'the prior-success-clobber-guard rejection returns v_existing.attempt_number unchanged');
    const rejection2 = sql.match(/Another request already claimed this exact key[\s\S]*?RETURN QUERY SELECT v_existing\.id, false, v_existing\.attempt_number;/);
    assert(!!rejection2, 'the active-pending-claim-guard rejection returns v_existing.attempt_number unchanged');

    assert(/RETURNING resume_analyses\.id, resume_analyses\.attempt_number INTO v_id, v_attempt/.test(sql),
      'the successful-claim INSERT captures the row\'s resulting attempt_number via RETURNING');
    assert(/RETURN QUERY SELECT v_id, true, v_attempt;/.test(sql),
      'the successful-claim path returns the real post-write attempt_number, not a guess');
  }

  console.log('\n5. reserve_resume_analysis(p_analysis_id, p_attempt_number) — signature + ordering');
  {
    assert(/DROP FUNCTION IF EXISTS public\.reserve_resume_analysis\(\)/.test(sql),
      'the old zero-arg reserve_resume_analysis() is dropped (adding params requires DROP, not CREATE OR REPLACE)');
    assert(/CREATE FUNCTION public\.reserve_resume_analysis\(\s*p_analysis_id\s+UUID,\s*p_attempt_number\s+INT\s*\)/.test(sql),
      'reserve_resume_analysis is recreated taking (p_analysis_id, p_attempt_number)');
    assert(/GRANT EXECUTE ON FUNCTION public\.reserve_resume_analysis\(uuid, int\) TO authenticated/.test(sql),
      'EXECUTE is re-granted to authenticated (DROP also drops prior grants)');

    const reserveBody = sql.slice(sql.indexOf('CREATE FUNCTION public.reserve_resume_analysis'), sql.indexOf('CREATE FUNCTION public.refund_resume_analysis'));
    const idxExistingCheck = reserveBody.indexOf('already_reserved');
    const idxLimitCheck = reserveBody.indexOf('limit_reached');
    const idxInsertReserved = reserveBody.lastIndexOf("'reserved'");
    assert(idxExistingCheck > -1 && idxLimitCheck > -1 && idxInsertReserved > -1,
      'all three outcomes (already_reserved, limit_reached, reserved) appear in reserve_resume_analysis');
    assert(idxExistingCheck < idxLimitCheck,
      'the finalized ordering: the idempotency check (already_reserved) happens BEFORE the quota-limit check (limit_reached)',
      `already_reserved@${idxExistingCheck}, limit_reached@${idxLimitCheck}`);
    assert(idxLimitCheck < idxInsertReserved,
      'the quota-limit check happens BEFORE the increment+insert — a limit_reached outcome never leaves a reserved event behind',
      `limit_reached@${idxLimitCheck}, reserved-insert@${idxInsertReserved}`);
    assert(/v_analysis\.attempt_number <> p_attempt_number THEN[\s\S]*?stale_attempt/.test(reserveBody),
      'reservation requires the attempt to be CURRENT (stale_attempt rejects an old attempt number)');

    // Stage 5 independent-review fixes (2026-11-02).
    assert(/FROM resume_analyses\s*\n\s*WHERE id = p_analysis_id\s*\n\s*FOR UPDATE;/.test(reserveBody),
      'finding #1 fix: the resume_analyses ownership/currency read in reserve_resume_analysis is now FOR UPDATE, serializing against a concurrent upsert_resume_analysis() reclaim');
    // Anchored on the literal result-returning occurrence ('result', 'already_reserved'), not any
    // earlier comment mentioning the word -- the body now mentions "already_reserved" twice.
    const alreadyReservedIdx = reserveBody.indexOf("'result', 'already_reserved'");
    const alreadyReservedBlock = reserveBody.slice(alreadyReservedIdx - 400, alreadyReservedIdx + 200);
    assert(/UPDATE profiles SET/.test(alreadyReservedBlock),
      'finding #4 fix: the already_reserved path now persists the lazy day-rollover to profiles, not just the reserved/limit_reached paths');
    assert(/'remaining', GREATEST\(0, v_limit - v_row\.daily_resume_analyses_count\)/.test(reserveBody),
      'finding #4 fix: already_reserved\'s response now includes remaining, matching the reserved/limit_reached responses');
  }

  console.log('\n6. refund_resume_analysis(p_analysis_id, p_attempt_number, p_reason) — signature + historical refund + cross-day safety');
  {
    assert(/DROP FUNCTION IF EXISTS public\.refund_resume_analysis\(\)/.test(sql),
      'the old zero-arg refund_resume_analysis() is dropped');
    assert(/CREATE FUNCTION public\.refund_resume_analysis\(\s*p_analysis_id\s+UUID,\s*p_attempt_number\s+INT,\s*p_reason\s+TEXT\s*\)/.test(sql),
      'refund_resume_analysis is recreated taking (p_analysis_id, p_attempt_number, p_reason)');
    assert(/GRANT EXECUTE ON FUNCTION public\.refund_resume_analysis\(uuid, int, text\) TO authenticated/.test(sql),
      'EXECUTE is re-granted to authenticated');

    const refundBody = sql.slice(sql.indexOf('CREATE FUNCTION public.refund_resume_analysis'));
    assert(!/v_analysis\.attempt_number/.test(refundBody),
      'refund never reads/compares the row\'s CURRENT attempt_number — a historical attempt (superseded by a later reclaim) must remain refundable',
      'found a reference to v_analysis.attempt_number in refund_resume_analysis');
    assert(/already_refunded/.test(refundBody), 'a second refund for the same attempt is rejected (already_refunded), not double-applied');
    assert(/no_reservation/.test(refundBody), 'a refund with no matching reserved event is rejected, not silently accepted');
    assert(/p_reason IS NULL OR p_reason = ''/.test(refundBody), 'an empty/missing reason is rejected before any write');

    assert(/SELECT id, profile_id INTO v_analysis FROM resume_analyses WHERE id = p_analysis_id FOR UPDATE;/.test(refundBody),
      'finding #1 fix: the resume_analyses ownership read in refund_resume_analysis is also FOR UPDATE, for the same lock-ordering reason as reserve');

    const rolloverMatch = refundBody.match(/IF v_row\.usage_date = v_reserved\.usage_date THEN([\s\S]*?)END IF;/);
    assert(!!rolloverMatch, 'the cross-day comparison (profile.usage_date vs the reservation\'s own stored usage_date) is present');
    assert(/GREATEST\(0, daily_resume_analyses_count - 1\)/.test(rolloverMatch?.[1] ?? ''),
      'same-period refund decrements the live counter (floor at 0)');
    assert(!/usage_date\s*=\s*v_today/.test(refundBody),
      'refund never performs its own lazy day-rollover reset — that stays reserve_resume_analysis\'s sole responsibility',
      'found a usage_date reset inside refund_resume_analysis');
  }

  console.log('\n7. prior migrations (036-039) are not touched by this file');
  {
    assert(!/CREATE OR REPLACE FUNCTION public\.upsert_resume_analysis\([^)]*\)\s*\nRETURNS TABLE \(id UUID, wrote BOOLEAN\)/.test(sql),
      'this migration does not reintroduce the old 2-column RETURNS TABLE shape (039\'s own, left alone)');
    for (const priorFile of ['036_resume_intelligence.sql', '037_resume_intelligence_acl_hardening.sql', '038_resume_upsert_analysis_ambiguity_fix.sql', '039_resume_upsert_analysis_new_key_race_fix.sql']) {
      const priorSql = readFileSync(join(MIGRATIONS_DIR, priorFile), 'utf8');
      assert(priorSql.length > 0, `${priorFile} is present and unmodified by this session (read-only reference, not edited)`);
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
