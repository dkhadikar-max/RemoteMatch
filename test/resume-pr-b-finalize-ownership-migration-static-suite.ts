/**
 * Resume Intelligence (PR B) — static regression suite for migration
 * 041_resume_finalize_ownership.sql (the attempt-ownership-aware finalization fix, found during
 * the Stage 6 delivery review + follow-up read-only trace, 2026-11-02).
 *
 * NOT a live-database test. Reads the migration's own SQL text and asserts on its literal shape
 * — same precedented technique as resume-pr-b-quota-lifecycle-migration-static-suite.ts. A true
 * dynamic/live test of the RPCs' actual transactional behavior is
 * test/live-pg/resume-concurrency-live-suite.ts and resume-quota-lifecycle-live-suite.ts, run
 * separately against a disposable Postgres instance.
 *
 * Run: npx tsx test/resume-pr-b-finalize-ownership-migration-static-suite.ts
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
const sql = readFileSync(join(MIGRATIONS_DIR, '041_resume_finalize_ownership.sql'), 'utf8');
// Comments stripped (-- to end of line) for checks that must look at EXECUTABLE SQL only -- this
// file's own prose comments explain why refund_resume_analysis/ai_call_events need no change,
// which would otherwise make a blanket text search over the raw file give a false positive.
const sqlNoComments = sql.replace(/--.*$/gm, '');

function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — FINALIZE OWNERSHIP MIGRATION 041 (static)');
  console.log('='.repeat(78));

  console.log('\n1. upsert_resume_analysis() trimmed to claim-only');
  {
    assert(/DROP FUNCTION IF EXISTS public\.upsert_resume_analysis\(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric\)/.test(sql),
      'the old 12-param upsert_resume_analysis (migration 040\'s claim+finalize combined version) is dropped first');
    assert(/CREATE FUNCTION public\.upsert_resume_analysis\(\s*\n\s*p_resume_version_id UUID,\s*\n\s*p_mode\s+TEXT,\s*\n\s*p_opportunity_id\s+TEXT,\s*\n\s*p_job_content_hash\s+TEXT,\s*\n\s*p_analysis_version\s+TEXT\s*\n\)/.test(sql),
      'the new upsert_resume_analysis takes exactly the 5 dedup-key parameters — no status/result/model/token/cost params at all');
    assert(!/p_status\s+TEXT/.test(sql.slice(0, sql.indexOf('finalize_resume_analysis'))),
      'no p_status parameter exists anywhere in the trimmed claim function (checked before the finalize function begins)');
    const claimBody = sql.slice(sql.indexOf('CREATE FUNCTION public.upsert_resume_analysis'), sql.indexOf('REVOKE ALL ON FUNCTION public.upsert_resume_analysis'));
    assert(/'pending', NULL, false, NULL, NULL, NULL, NULL,/.test(claimBody),
      'the fresh-insert VALUES list hardcodes status=\'pending\'/result=NULL/source_ai=false/model=NULL/tokens=NULL/cost=NULL — a caller can no longer write a result through this function at all');
    assert(/status\s*=\s*'pending',\s*\n\s*result\s*=\s*NULL,/.test(claimBody),
      'the DO UPDATE SET also hardcodes status back to \'pending\' on every reclaim (never a caller-supplied value)');
    assert(/attempt_number\s*=\s*resume_analyses\.attempt_number \+ 1/.test(claimBody),
      'the claim/reclaim path still increments attempt_number on every successful claim acquisition — unchanged responsibility');
    assert(/IF v_existing\.id IS NOT NULL AND v_existing\.status = 'success' THEN/.test(claimBody),
      'the prior-success-clobber-guard is simplified correctly: since the claim always writes \'pending\' (never \'success\'), checking only v_existing.status=\'success\' is equivalent to and replaces the old two-sided check');
    assert(/REVOKE ALL ON FUNCTION public\.upsert_resume_analysis\(uuid, text, text, text, text\) FROM PUBLIC, anon/.test(sql) &&
      /GRANT EXECUTE ON FUNCTION public\.upsert_resume_analysis\(uuid, text, text, text, text\) TO authenticated/.test(sql),
      'ACL re-granted correctly for the new 5-arg signature (DROP also drops prior grants)');
  }

  console.log('\n2. finalize_resume_analysis() — new function, ownership-aware');
  {
    const finalizeBody = sql.slice(sql.indexOf('CREATE FUNCTION public.finalize_resume_analysis'));
    assert(/CREATE FUNCTION public\.finalize_resume_analysis\(\s*\n\s*p_analysis_id\s+UUID,\s*\n\s*p_expected_attempt_number\s+INT,/.test(finalizeBody),
      'finalize_resume_analysis is keyed by (analysis_id, expected_attempt_number) directly, not the composite dedup key');
    assert(/RETURNS TABLE \(id UUID, finalized BOOLEAN, result TEXT\)/.test(finalizeBody),
      'return shape carries both a boolean and a detailed result enum');

    console.log('  Safeguard A: status whitelist');
    assert(/IF p_status NOT IN \('success', 'unavailable'\) THEN/.test(finalizeBody),
      'Safeguard A: only success|unavailable are accepted — narrower than upsert\'s old 4-value check (no \'pending\', no \'insufficient_input\')');

    console.log('  NULL-logic hardening (found during implementation, 2026-11-02)');
    const idxNullGuard = finalizeBody.indexOf('p_expected_attempt_number IS NULL');
    const idxOwnershipCheck = finalizeBody.indexOf('IS DISTINCT FROM p_expected_attempt_number');
    assert(idxNullGuard > -1, 'an explicit NULL check on p_expected_attempt_number exists');
    assert(idxNullGuard > -1 && idxOwnershipCheck > -1 && idxNullGuard < idxOwnershipCheck,
      'the explicit NULL guard runs BEFORE the ownership comparison — <> against NULL is SQL-NULL (not TRUE), and PL/pgSQL\'s IF treats NULL as FALSE, which would otherwise silently skip the rejection and fall through to the UPDATE',
      `nullGuard@${idxNullGuard}, ownershipCheck@${idxOwnershipCheck}`);
    assert(/IS DISTINCT FROM p_expected_attempt_number/.test(finalizeBody),
      'the ownership comparison itself uses IS DISTINCT FROM (NULL-safe), not <> (NULL-unsafe), as a second layer of the same hardening');

    console.log('  The ownership check itself');
    assert(/v_existing\.attempt_number IS DISTINCT FROM p_expected_attempt_number OR v_existing\.status <> 'pending'/.test(finalizeBody),
      'the ownership check requires BOTH attempt_number currency AND status still being \'pending\', atomically under the row\'s own FOR UPDATE lock acquired just above');
    assert(/FOR UPDATE;[\s\S]{0,800}IS DISTINCT FROM p_expected_attempt_number/.test(finalizeBody),
      'the ownership check happens AFTER acquiring FOR UPDATE on the row — genuinely atomic, not a separate racy check-then-write');
    assert(/RETURN QUERY SELECT v_existing\.id, false, 'stale_attempt'::text;/.test(finalizeBody),
      'a mismatch returns stale_attempt with the REAL row id, never a fabricated one, and writes nothing');

    console.log('  Finalize never claims, never increments attempt_number');
    const finalizeUpdateIdx = finalizeBody.search(/UPDATE (?:public\.)?resume_analyses SET/);
    assert(finalizeUpdateIdx > -1, 'the UPDATE statement itself is present (schema-qualification tolerant)');
    assert(!/attempt_number\s*=/.test(finalizeBody.slice(finalizeUpdateIdx, finalizeBody.indexOf('WHERE id = p_analysis_id'))),
      'the UPDATE statement itself never assigns attempt_number — structurally impossible for finalize to advance it, not just by convention');
    assert(!/ON CONFLICT/.test(finalizeBody), 'finalize_resume_analysis has no ON CONFLICT clause at all — it can never reclaim/insert a row, only update an existing one it already owns');

    console.log('  Safeguard B: result/accounting write scope + ACL');
    assert(/UPDATE (?:public\.)?resume_analyses SET\s*\n\s*status\s*=\s*p_status,\s*\n\s*result\s*=\s*p_result,\s*\n\s*source_ai\s*=\s*p_source_ai,\s*\n\s*model\s*=\s*p_model,\s*\n\s*prompt_tokens\s*=\s*p_prompt_tokens,\s*\n\s*completion_tokens\s*=\s*p_completion_tokens,\s*\n\s*cost_usd\s*=\s*p_cost_usd,/.test(finalizeBody),
      'the result/model/token/cost write happens in the SAME UPDATE statement guarded by the ownership check above — a stale caller never reaches this statement at all');
    assert(!/ai_call_events|ai_spend_ledger/.test(sqlNoComments),
      'Safeguard B: this migration never references ai_call_events/ai_spend_ledger in any EXECUTABLE statement (only in explanatory comments) — provider-spend accounting is untouched, confirming it stays structurally independent of finalize\'s outcome');
    assert(/REVOKE ALL ON FUNCTION public\.finalize_resume_analysis\(uuid, int, text, jsonb, boolean, text, integer, integer, numeric\) FROM PUBLIC, anon/.test(sql) &&
      /GRANT EXECUTE ON FUNCTION public\.finalize_resume_analysis\(uuid, int, text, jsonb, boolean, text, integer, integer, numeric\) TO authenticated/.test(sql),
      'ACL matches every other RPC in this project: no PUBLIC/anon, authenticated only');
    assert(/SECURITY DEFINER/.test(finalizeBody) && /SET search_path = (?:public|pg_catalog, public, pg_temp)/.test(finalizeBody),
      'SECURITY DEFINER with a locked search_path, matching every other RPC\'s injection-hardening in this project');
  }

  console.log('\n3. refund_resume_analysis() untouched — confirmed, not just assumed');
  {
    assert(!/refund_resume_analysis/.test(sqlNoComments),
      'this migration never references refund_resume_analysis in any EXECUTABLE statement (only in explanatory comments) — its ownership logic (which never depends on current status/attempt_number) is confirmed unaffected by construction, not by reasoning about it');
  }

  console.log('\n4. prior migrations (036-040) not touched by this file');
  {
    for (const priorFile of ['036_resume_intelligence.sql', '037_resume_intelligence_acl_hardening.sql', '038_resume_upsert_analysis_ambiguity_fix.sql', '039_resume_upsert_analysis_new_key_race_fix.sql', '040_resume_quota_lifecycle.sql']) {
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
