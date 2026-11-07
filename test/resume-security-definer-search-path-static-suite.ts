/**
 * Static regression checks for Resume Intelligence SECURITY DEFINER hardening.
 * This does not replace the separately authorized live PostgreSQL shadowing test.
 * Run: npx tsx test/resume-security-definer-search-path-static-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${message}`); }
  else { failed++; console.error(`  ✗ FAIL: ${message}`); }
}

const dir = join(__dirname, '..', 'supabase', 'migrations');
const files = [
  '036_resume_intelligence.sql',
  '038_resume_upsert_analysis_ambiguity_fix.sql',
  '039_resume_upsert_analysis_new_key_race_fix.sql',
  '040_resume_quota_lifecycle.sql',
  '041_resume_finalize_ownership.sql',
  '042_resume_quota_reconciliation.sql',
];
const relations = 'profiles|resume_versions|resume_analyses|resume_suggestion_decisions|resume_quota_events';

function main() {
  let functionCount = 0;
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const sql = raw.replace(/--.*$/gm, '');
    const definitions = [...sql.matchAll(/SECURITY DEFINER\\s+SET search_path\\s*=\\s*([^\\r\\n]+)/gi)];
    functionCount += definitions.length;
    assert(definitions.length > 0, `${file}: SECURITY DEFINER definitions found`);
    for (const definition of definitions) {
      assert(
        definition[1].trim() === 'pg_catalog, public, pg_temp',
        `${file}: SECURITY DEFINER uses pg_catalog, public, pg_temp in that order`,
      );
    }
    assert(
      !/SECURITY DEFINER\\s+SET search_path\\s*=\\s*public(?:\\s|$)/i.test(sql),
      `${file}: no SECURITY DEFINER function retains SET search_path = public`,
    );
    const unqualified = new RegExp(
      `\\\\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE|ON)\\\\s+(?:IF\\\\s+NOT\\\\s+EXISTS\\\\s+)?(?:${relations})\\\\b`,
      'i',
    );
    assert(!unqualified.test(sql), `${file}: persistent resume/profile relations are schema-qualified`);
  }
  assert(functionCount === 13, `all 13 SECURITY DEFINER definitions across migrations 036–042 are covered (found ${functionCount})`);
  console.log(`\\nRESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
main();
