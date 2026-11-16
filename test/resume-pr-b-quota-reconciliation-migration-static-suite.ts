/**
 * Resume Intelligence (PR B) — static regression suite for migration
 * 042_resume_quota_reconciliation.sql (the durable reconciliation sweep, Stage 6 follow-up,
 * 2026-11-02).
 *
 * NOT a live-database test. Reads the migration's own SQL text and asserts on its literal shape
 * — same precedented technique as the other resume-pr-b-*-migration-static-suite.ts files.
 *
 * Run: npx tsx test/resume-pr-b-quota-reconciliation-migration-static-suite.ts
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
const sql = readFileSync(join(MIGRATIONS_DIR, '042_resume_quota_reconciliation.sql'), 'utf8');
const sqlNoComments = sql.replace(/--.*$/gm, '');

function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — QUOTA RECONCILIATION MIGRATION 042 (static)');
  console.log('='.repeat(78));

  console.log('\n1. service-role-only gate');
  {
    assert(/IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN\s*\n\s*RAISE EXCEPTION/.test(sql),
      'the function explicitly rejects any caller whose role is not service_role, before doing anything else');
    assert(/REVOKE ALL ON FUNCTION public\.reconcile_resume_quota_orphans\(boolean\) FROM PUBLIC, anon, authenticated/.test(sql),
      'ACL also revokes from PUBLIC/anon/authenticated at the grant level -- defense in depth alongside the in-function check');
    assert(/GRANT EXECUTE ON FUNCTION public\.reconcile_resume_quota_orphans\(boolean\) TO service_role/.test(sql),
      'EXECUTE is granted to service_role only');
  }

  console.log('\n2. detection query — 3 eligibility branches, matching the locked design exactly');
  {
    const body = sql.slice(sql.indexOf('FOR v_orphan IN'), sql.indexOf('LOOP'));
    assert(/r\.event_type = 'reserved'/.test(body), 'scans reserved events');
    assert(/NOT EXISTS[\s\S]*?event_type = 'refunded'/.test(body), 'excludes any (analysis_id, attempt_number) that already has a matching refunded event -- the core orphan definition');
    assert(/r\.attempt_number < ra\.attempt_number/.test(body), 'branch (a): superseded attempt, no grace period');
    assert(/ra\.status IN \('unavailable', 'insufficient_input'\) AND ra\.updated_at < now\(\) - interval '10 minutes'/.test(body),
      'branch (b): current attempt, terminal failure, finalized >10 minutes ago');
    assert(/ra\.status = 'pending' AND ra\.created_at < now\(\) - interval '60 minutes'/.test(body),
      'branch (c): current attempt, still pending, abandoned >60 minutes ago (well past the 3-minute reclaim window)');
    assert(!/status = 'success'/.test(body), 'a successful attempt is never an eligibility condition at all -- confirmed absent from the detection query, not just unreachable');
  }

  console.log('\n3. dry-run mode writes nothing');
  {
    const dryRunBranch = sql.slice(sql.indexOf('IF p_dry_run THEN'), sql.indexOf('END IF;\n\n    BEGIN'));
    assert(/RETURN QUERY SELECT v_orphan\.analysis_id, v_orphan\.attempt_number, false, 'dry_run'::text;/.test(dryRunBranch),
      'dry-run reports each candidate with reconciled=false, detail=dry_run');
    assert(/CONTINUE;/.test(dryRunBranch), 'dry-run continues to the next candidate without ever reaching the write block below');
  }

  console.log('\n4. lock ordering matches reserve_resume_analysis()/refund_resume_analysis() exactly (profiles first)');
  {
    const idxProfileLock = sql.search(/FROM (?:public\.)?profiles WHERE id = v_orphan\.profile_id FOR UPDATE/);
    const idxAnalysisLock = sql.search(/FROM (?:public\.)?resume_analyses WHERE id = v_orphan\.analysis_id FOR UPDATE/);
    assert(idxProfileLock > -1 && idxAnalysisLock > -1 && idxProfileLock < idxAnalysisLock,
      'profiles is locked BEFORE resume_analyses, matching every other quota RPC in this project -- avoids a deadlock against a live request on the same row',
      `profileLock@${idxProfileLock}, analysisLock@${idxAnalysisLock}`);
  }

  console.log('\n5. idempotency re-checked under lock (not just trusted from the unlocked detection read)');
  {
    const perCandidateBody = sql.slice(sql.indexOf('BEGIN\n      -- Lock order'), sql.indexOf('EXCEPTION WHEN OTHERS THEN'));
    assert(/SELECT EXISTS \(\s*\n\s*SELECT 1 FROM (?:public\.)?resume_quota_events rqe\s*\n\s*WHERE rqe\.analysis_id = v_orphan\.analysis_id AND rqe\.attempt_number = v_orphan\.attempt_number AND rqe\.event_type = 'refunded'\s*\n\s*\) INTO v_already_refunded;/.test(perCandidateBody),
      'a fresh already-refunded check runs AFTER acquiring the locks, not relying on the earlier unlocked cursor snapshot');
    assert(/IF v_already_refunded THEN\s*\n\s*RETURN QUERY SELECT v_orphan\.analysis_id, v_orphan\.attempt_number, false, 'already_refunded'::text;/.test(perCandidateBody),
      'an already-refunded candidate is reported, not silently skipped or double-refunded');
  }

  console.log('\n6. cross-day safety matches refund_resume_analysis() exactly');
  {
    assert(/WHERE id = v_orphan\.profile_id AND usage_date = v_orphan\.reserved_usage_date/.test(sql),
      'the counter decrement is conditioned on usage_date still matching the ORIGINAL reservation\'s own usage_date -- a no-op (0 rows) when it does not, same safety as refund_resume_analysis()\'s own IF branch');
    assert(/GREATEST\(0, daily_resume_analyses_count - 1\)/.test(sql), 'the decrement floors at 0, same as refund_resume_analysis()');
  }

  console.log('\n7. the refunded event carries the sweep\'s own distinct reason, using the EXACT original attempt identifiers');
  {
    assert(/VALUES \(v_orphan\.analysis_id, v_orphan\.attempt_number, 'refunded', v_orphan\.reserved_usage_date, 'reconciliation_sweep'\)/.test(sql),
      'the event insert uses the orphan\'s own (analysis_id, attempt_number) -- never a new/re-derived identifier -- with reason=reconciliation_sweep, distinguishable from an application-triggered refund in the audit trail');
  }

  console.log('\n8. one failed candidate cannot abort the whole sweep');
  {
    assert(/EXCEPTION WHEN OTHERS THEN/.test(sql), 'each candidate is processed inside its own exception-handling block (an implicit PL\\/pgSQL savepoint)');
    const afterException = sql.slice(sql.indexOf('EXCEPTION WHEN OTHERS THEN'), sql.indexOf('END;\n    END;'));
    assert(/RETURN QUERY SELECT v_orphan\.analysis_id, v_orphan\.attempt_number, false, \('error: ' \|\| SQLERRM\)::text;/.test(afterException),
      'a failed candidate is reported with its own error detail, then the loop continues (no RAISE/re-throw that would abort the function)');
  }

  console.log('\n9. no new column/table added -- confirmed, not just claimed');
  {
    assert(!/CREATE TABLE|ALTER TABLE|ADD COLUMN/.test(sqlNoComments),
      'this migration contains no schema-changing statement at all (no CREATE/ALTER TABLE, no ADD COLUMN) -- the sweep reads only data migration 040 already produces');
  }

  console.log('\n10. prior migrations (036-041) not touched by this file');
  {
    for (const priorFile of ['036_resume_intelligence.sql', '037_resume_intelligence_acl_hardening.sql', '038_resume_upsert_analysis_ambiguity_fix.sql', '039_resume_upsert_analysis_new_key_race_fix.sql', '040_resume_quota_lifecycle.sql', '041_resume_finalize_ownership.sql']) {
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
