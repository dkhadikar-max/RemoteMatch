/**
 * Resume Intelligence (PR B) — static checks for migration 037's ACL-hardening fix.
 *
 * PREPARED, NOT RUN. Source-pattern assertions only — no database connection, nothing executed.
 * These prove the migration FILE's text has the right statements in the right shape; they do not
 * and cannot prove the live ACL state after applying it (that is exactly what the new live-only
 * checks added to test/live-pg/resume-concurrency-live-suite.ts's Section 1 are for — see its own
 * comment there, and docs/resume-pr-b-live-migration-acl-fix-2026-10-22.md for the finding this
 * migration fixes).
 *
 * Run: npx tsx test/resume-acl-hardening-static-suite.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = join(__dirname, '..');
const MIGRATION_PATH = 'supabase/migrations/037_resume_intelligence_acl_hardening.sql';

async function main() {
  console.log('='.repeat(78));
  console.log('MIGRATION 037 (resume intelligence ACL hardening) — STATIC CHECKS ONLY');
  console.log('='.repeat(78));

  console.log('\n1. File exists as a genuinely NEW forward migration, not an edit to 036');
  assert(existsSync(join(root, MIGRATION_PATH)), `${MIGRATION_PATH} exists`);
  assert(!existsSync(join(root, 'supabase/migrations/037_resume_intelligence_acl_hardening.sql.orig')), 'no stray backup/orig file left behind');
  const migration036 = readFileSync(join(root, 'supabase/migrations/036_resume_intelligence.sql'), 'utf8');
  assert(!/ACL hardening|acl_hardening/i.test(migration036), 'migration 036 itself is untouched — no trace of this fix was written back into the already-applied file');

  const migration037 = readFileSync(join(root, MIGRATION_PATH), 'utf8');

  console.log('\n2. Exact signatures targeted — matches migration 036\'s own function definitions verbatim');
  const expectedSignatures = [
    'public.create_resume_version(text, text, text, uuid)',
    'public.record_resume_suggestion_decision(uuid, text, text, text)',
  ];
  for (const sig of expectedSignatures) {
    assert(migration037.includes(sig), `targets the exact signature ${sig}`);
  }
  // upsert_resume_analysis's signature is written across multiple lines in both files; check the
  // parameter list appears, not a single-line literal match.
  assert(/upsert_resume_analysis\(\s*\n\s*uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric\s*\n\s*\)/.test(migration037),
    'targets the exact (multi-line) upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric) signature');

  console.log('\n3. REVOKE ALL ... FROM PUBLIC, anon precedes the re-GRANT, for all three target functions');
  for (const fn of ['create_resume_version', 'record_resume_suggestion_decision']) {
    const revokeIdx = migration037.indexOf(`REVOKE ALL ON FUNCTION public.${fn}`);
    const grantIdx = migration037.indexOf(`GRANT EXECUTE ON FUNCTION public.${fn}`);
    assert(revokeIdx > -1 && grantIdx > -1 && revokeIdx < grantIdx, `${fn}: REVOKE appears before the re-GRANT`, `revokeIdx=${revokeIdx} grantIdx=${grantIdx}`);
    assert(migration037.slice(revokeIdx, revokeIdx + 200).includes('FROM PUBLIC, anon'), `${fn}: REVOKE targets PUBLIC and anon explicitly`);
  }
  const upsertRevokeIdx = migration037.indexOf('REVOKE ALL ON FUNCTION public.upsert_resume_analysis');
  const upsertGrantIdx = migration037.indexOf('GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis');
  assert(upsertRevokeIdx > -1 && upsertGrantIdx > -1 && upsertRevokeIdx < upsertGrantIdx, 'upsert_resume_analysis: REVOKE appears before the re-GRANT');
  assert(migration037.slice(upsertRevokeIdx, upsertRevokeIdx + 200).includes('FROM PUBLIC, anon'), 'upsert_resume_analysis: REVOKE targets PUBLIC and anon explicitly');

  console.log('\n4. authenticated is re-granted EXECUTE for all three (never left with zero access)');
  for (const fn of ['create_resume_version', 'upsert_resume_analysis', 'record_resume_suggestion_decision']) {
    const grantToAuthPattern = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]{0,200}?TO authenticated;`);
    assert(grantToAuthPattern.test(migration037), `${fn}: explicitly re-GRANTed EXECUTE to authenticated after the REVOKE`);
  }

  console.log('\n5. Scope safety — reserve_resume_analysis/refund_resume_analysis (already correctly scoped in 036) have no REVOKE/GRANT statement in this migration');
  // Note: the header comment DOES mention these two by name (explaining they were already correct
  // in 036) — that's expected prose, not a scope violation. Restrict this check to the executable
  // SQL body only (between the top-level BEGIN; and COMMIT;), excluding all comment lines, so the
  // explanatory prose above can't produce a false positive.
  const sqlBody = migration037
    .slice(migration037.indexOf('\nBEGIN;'), migration037.lastIndexOf('COMMIT;'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert(!sqlBody.includes('reserve_resume_analysis'), 'no executable statement in the SQL body references reserve_resume_analysis — out of scope for this fix, already correct', sqlBody.includes('reserve_resume_analysis') ? 'found in sqlBody' : undefined);
  assert(!sqlBody.includes('refund_resume_analysis'), 'no executable statement in the SQL body references refund_resume_analysis — out of scope for this fix, already correct');
  assert(!/CREATE TABLE|CREATE INDEX|DROP TABLE|ALTER TABLE/i.test(migration037), 'this migration touches ONLY grants — no schema/table changes, consistent with a least-privilege-only fix');

  console.log('\n6. Transactional safety, matching 00-bootstrap.sql\'s own established pattern');
  assert(/\\set ON_ERROR_STOP on/.test(migration037), 'ON_ERROR_STOP is set');
  assert(/^BEGIN;/m.test(migration037) && /^COMMIT;/m.test(migration037), 'wrapped in an explicit top-level BEGIN/COMMIT (unlike 036, which relies on psql -1 instead)');

  console.log('\n7. A manual DOWN is documented (not automated, but present for operator reference)');
  assert(/-- DOWN/.test(migration037), 'a DOWN section exists in a trailing comment');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  console.log('\nReminder: these are static/source checks only. They do not prove the live ACL state');
  console.log('after applying this migration — only an actual (separately authorized) apply + the new');
  console.log('PUBLIC/anon-absence checks in resume-concurrency-live-suite.ts Section 1 can prove that.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
