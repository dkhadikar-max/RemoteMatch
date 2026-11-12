import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const migrations = [
  '20261112185212_v2_p0_m2_m3_application_lifecycle.sql',
  '20261112185655_v2_p0_m3_lifecycle_hardening.sql',
  '20261112185730_v2_p0_m3_link_integrity_guards.sql',
  '20261112185902_v2_p0_m3_private_helper_privileges.sql',
  '20261112190030_v2_p0_m3_event_writer_rls_and_fk_indexes.sql',
  '20261112190152_v2_p0_m3_event_timestamps_and_fk_indexes.sql',
  '20261112190248_v2_p0_m3_scope_guard_application_audit_only.sql',
];

for (const migration of migrations) {
  const path = join(root, 'supabase/migrations', migration);
  assert.equal(existsSync(path), true, `missing applied migration source: ${migration}`);
  assert.ok(read(`supabase/migrations/${migration}`).length > 100);
}

const applyRoute = read('src/app/api/employer-jobs/[opportunityId]/apply/route.ts');
assert.match(applyRoute, /auth\.supabase\.rpc\('apply_to_employer_job'/);
assert.doesNotMatch(applyRoute, /getSupabaseAdminClient|\.from\('employer_job_applications'\)\.insert/);

const employerRoute = read('src/app/api/employer/companies/[id]/applications/route.ts');
assert.match(employerRoute, /db\.rpc\('transition_employer_application'/);
assert.match(employerRoute, /p_expected_status: expectedStatus/);
assert.match(employerRoute, /p_idempotency_key: idempotencyKey/);
assert.doesNotMatch(employerRoute, /\.from\('employer_job_applications'\)\s*\.update/);

const candidateRoute = read('src/app/api/applications/status/route.ts');
assert.match(candidateRoute, /transition_application_status/);
assert.match(candidateRoute, /'offer_declined'/);
assert.match(candidateRoute, /managed_by_employer/);

const archiveRoute = read('src/app/api/applications/archive/route.ts');
assert.match(archiveRoute, /set_application_archived/);

const rewindRoute = read('src/app/api/opportunities/rewind/route.ts');
assert.match(rewindRoute, /application_submitted/);
assert.match(rewindRoute, /application_state_conflict/);

const employerPage = read('src/app/employer/companies/[id]/applications/page.tsx');
assert.match(employerPage, /expectedStatus: row\.status/);
assert.match(employerPage, /idempotencyKey: crypto\.randomUUID\(\)/);
assert.match(employerPage, /Decision reason/);

console.log('V2 P0 M2/M3 API contract suite: 7 migration files + 8 route/UI contract groups passed.');
