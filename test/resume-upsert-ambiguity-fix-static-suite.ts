/**
 * Resume Intelligence (PR B) — static checks for migration 038 (the upsert_resume_analysis
 * column-ambiguity fix) and the two harness additions it required.
 *
 * PREPARED, NOT RUN. Source-pattern assertions only — no database connection, nothing executed.
 * These prove the migration/harness FILES' text have the right shape; they do not and cannot
 * prove the live behavior (that the function actually executes without 42702, that the valid-call
 * regression test actually passes, or that the feature flag actually reaches the database) — only
 * an actual, separately-authorized apply + harness run can prove that.
 *
 * Run: npx tsx test/resume-upsert-ambiguity-fix-static-suite.ts
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
const MIGRATION_038 = 'supabase/migrations/038_resume_upsert_analysis_ambiguity_fix.sql';

async function main() {
  console.log('='.repeat(78));
  console.log('MIGRATION 038 (upsert_resume_analysis ambiguity fix) — STATIC CHECKS ONLY');
  console.log('='.repeat(78));

  console.log('\n1. New forward migration; 036 and 037 unchanged');
  assert(existsSync(join(root, MIGRATION_038)), `${MIGRATION_038} exists`);
  const migration036 = readFileSync(join(root, 'supabase/migrations/036_resume_intelligence.sql'), 'utf8');
  const migration037 = readFileSync(join(root, 'supabase/migrations/037_resume_intelligence_acl_hardening.sql'), 'utf8');
  assert(!/rv\.id = p_resume_version_id/.test(migration036), 'migration 036 itself is untouched — the alias fix was not written back into the already-applied file');
  assert(!/ambiguity_fix|42702/i.test(migration036) && !/ambiguity_fix|42702/i.test(migration037), 'neither 036 nor 037 was edited to reference this fix — it lives only in the new file');

  const migration038 = readFileSync(join(root, MIGRATION_038), 'utf8');

  console.log('\n2. Exact signature preserved (unchanged from 036/037)');
  assert(/CREATE OR REPLACE FUNCTION public\.upsert_resume_analysis\(/.test(migration038), 'uses CREATE OR REPLACE FUNCTION (preserves existing GRANTs — same signature, no DROP/CREATE)');
  assert(/RETURNS TABLE \(id UUID, wrote BOOLEAN\)/.test(migration038), 'return shape is unchanged (id UUID, wrote BOOLEAN) — callers (resume-intelligence-service.ts) need no changes');
  const paramListMatch = migration038.match(/CREATE OR REPLACE FUNCTION public\.upsert_resume_analysis\(([\s\S]*?)\)\nRETURNS/);
  assert(!!paramListMatch, 'parameter list is present and parseable');
  const expectedParams = ['p_resume_version_id UUID', 'p_mode              TEXT', 'p_opportunity_id    TEXT', 'p_job_content_hash  TEXT', 'p_analysis_version  TEXT', 'p_status            TEXT', 'p_result            JSONB', 'p_source_ai         BOOLEAN', 'p_model             TEXT', 'p_prompt_tokens     INTEGER', 'p_completion_tokens INTEGER', 'p_cost_usd          NUMERIC'];
  for (const p of expectedParams) {
    assert(migration038.includes(p), `parameter unchanged: ${p.trim()}`);
  }

  console.log('\n3. The ambiguity is actually fixed — qualified with an explicit alias');
  // Restrict the "old form is gone" check to the executable SQL body only (between the top-level
  // BEGIN; and COMMIT;), excluding comment lines — the header's own FINDING section legitimately
  // quotes the original buggy SQL verbatim to document what was wrong, which would otherwise be a
  // false positive here.
  const sqlBody038 = migration038
    .slice(migration038.indexOf('\nBEGIN;'), migration038.lastIndexOf('COMMIT;'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert(/FROM (?:public\.)?resume_versions rv WHERE rv\.id = p_resume_version_id AND rv\.profile_id = v_uid/.test(sqlBody038),
    'the ownership-check subquery uses an explicit "rv" alias for both id and profile_id, removing the ambiguity against the RETURNS TABLE id variable');
  assert(!/SELECT 1 FROM resume_versions WHERE id = p_resume_version_id/.test(sqlBody038),
    'the original unqualified (ambiguous) form is gone from the executable SQL (it is only quoted, for documentation, in the header comment)');

  console.log('\n4. Nothing else in the function changed — same logic, only the one line fixed');
  for (const preserved of [
    "v_existing.id IS NOT NULL AND v_existing.status = 'success'",
    "v_existing.id IS NOT NULL AND v_existing.status = 'pending'",
    'RETURNING resume_analyses.id INTO v_id',
    'RETURN QUERY SELECT v_id, true;',
    "ON CONFLICT (profile_id, resume_version_id, mode, job_content_hash, analysis_version) DO UPDATE SET",
  ]) {
    assert(migration038.includes(preserved), `unchanged logic preserved: "${preserved}"`);
  }

  console.log('\n5. No GRANT/REVOKE statement — 037 already set the correct ACLs for this exact signature');
  // Same scoping as above: the header prose mentions "GRANTs" (migration 037's own fix) while
  // explaining why none is needed here — check the executable SQL body only.
  assert(!/GRANT|REVOKE/.test(sqlBody038), 'migration 038\'s executable SQL contains no GRANT/REVOKE — CREATE OR REPLACE on the same signature preserves the ACL state migration 037 already established');

  console.log('\n6. Transactional safety, matching 037\'s established pattern');
  assert(/\\set ON_ERROR_STOP on/.test(migration038), 'ON_ERROR_STOP is set');
  assert(/^BEGIN;/m.test(migration038) && /^COMMIT;/m.test(migration038), 'wrapped in an explicit top-level BEGIN/COMMIT');

  console.log('\n7. Exhaustive-check claim is backed by evidence in the file’s own header');
  assert(/EXHAUSTIVE CHECK/.test(migration038), 'the header documents that every id/wrote reference was checked, not just the one that surfaced live');
  assert(/unique to upsert_resume_analysis/.test(migration038), 'the header states explicitly that the other 4 functions in 036 do not share this defect, and why');

  console.log('\n8. Harness: Section 2b (valid-call regression) and the scoped feature-flag addition both present');
  const harnessSrc = readFileSync(join(root, 'test/live-pg/resume-concurrency-live-suite.ts'), 'utf8');
  assert(/2b\. A VALID claim/.test(harnessSrc), 'Section 2b (valid, same-owner call) exists in the harness, not only the ownership-denial path');
  assert(/REGRESSION TEST for the 2026-10-23 live-run finding/.test(harnessSrc), 'Section 2b is documented as the regression test for this exact defect');
  const section2b = harnessSrc.slice(harnessSrc.indexOf('2b. A VALID claim'), harnessSrc.indexOf('3. Genuine concurrent race'));
  assert(/assert\(!error,/.test(section2b), 'Section 2b asserts the call succeeds with no error');
  assert(/assert\(!!\(row as \{ id\?: string \}\)\?\.id,/.test(section2b), 'Section 2b asserts a real row id is returned');
  assert(/wrote === true/.test(section2b), 'Section 2b asserts wrote === true for a genuinely new row');

  console.log('\n9. Feature-flag scoping — process-local only, not an application-default change');
  assert(/process\.env\.RESUME_INTELLIGENCE_ENABLED = 'true';/.test(harnessSrc), 'the harness sets the flag via process.env (this Node process only)');
  assert(!/writeFileSync\([^)]*\.env/.test(harnessSrc), 'the harness never writes to any .env file (checked for an actual file-write call, not just the word ".env" — which the explanatory comment legitimately uses)');
  const appServiceSrc = readFileSync(join(root, 'src/lib/ai/resume-intelligence-service.ts'), 'utf8');
  // Distinguish a genuine assignment (a single "=", not "===") from the comparison
  // isResumeIntelligenceEnabled() already does — a naive /=\s*/ regex would also match inside "===".
  const hasGenuineAssignment = /RESUME_INTELLIGENCE_ENABLED\s*(?<!=)=(?!=)\s*['"]/.test(appServiceSrc);
  const hasComparison = /RESUME_INTELLIGENCE_ENABLED\s*===\s*'true'/.test(appServiceSrc);
  assert(!hasGenuineAssignment, 'the application’s own service file never ASSIGNS a default to RESUME_INTELLIGENCE_ENABLED (only compares it)');
  assert(hasComparison, 'the application’s own service file only READS/COMPARES the flag (isResumeIntelligenceEnabled, === \'true\') — the harness’s process-local assignment cannot affect this read-only comparison or any other file, so application defaults remain unset/false everywhere else');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  console.log('\nReminder: these are static/source checks only. They do not prove the function now');
  console.log('executes successfully, or that the live concurrency race reaches the database — only an');
  console.log('actual, separately authorized apply + harness run can prove that.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
