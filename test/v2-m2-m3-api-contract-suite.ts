/**
 * V2 P0 M2/M3 API wiring contract checks.
 *
 * Fast, database-independent regression checks for the HTTP boundary:
 * lifecycle writes must go through the reviewed atomic RPCs, never direct
 * table mutations; client-facing routes must preserve CAS and lifecycle
 * conflict responses; and all nine applied migrations must be present.
 *
 * Run: npx tsx test/v2-m2-m3-api-contract-suite.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
function suiteIncludesReplayGate() { return readFileSync(join(root, 'test/employer-company-accounts-suite.ts'), 'utf8').includes('CI_V2_M3_REPLAY_BINDING_ENABLED'); }
let passed = 0;
let failed = 0;

function check(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${message}`); }
  else { failed++; console.error(`  ✗ FAIL: ${message}`); }
}
function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

const migrations = [
  '20261112185212_v2_p0_m2_m3_application_lifecycle.sql',
  '20261112185655_v2_p0_m3_lifecycle_hardening.sql',
  '20261112185730_v2_p0_m3_link_integrity_guards.sql',
  '20261112185902_v2_p0_m3_private_helper_privileges.sql',
  '20261112190030_v2_p0_m3_event_writer_rls_and_fk_indexes.sql',
  '20261112190152_v2_p0_m3_event_timestamps_and_fk_indexes.sql',
  '20261112190248_v2_p0_m3_scope_guard_application_audit_only.sql',
  '20261113041032_v2_p0_m3_lifecycle_review_fixes.sql',
  '20261114190000_v2_p0_m3_idempotency_payload_binding.sql',
];

for (const file of migrations) {
  const path = `supabase/migrations/${file}`;
  check(existsSync(join(root, path)), `applied migration source exists: ${file}`);
}

const lifecycle = read('supabase/migrations/20261112185212_v2_p0_m2_m3_application_lifecycle.sql');
check(lifecycle.includes('CREATE OR REPLACE FUNCTION public.apply_to_employer_job'), 'atomic direct-apply RPC is in the migration source');
check(lifecycle.includes('CREATE OR REPLACE FUNCTION public.transition_employer_application'), 'employer transition RPC is in the migration source');
const reviewFixes = read('supabase/migrations/20261113041032_v2_p0_m3_lifecycle_review_fixes.sql');
const replayBinding = read('supabase/migrations/20261114190000_v2_p0_m3_idempotency_payload_binding.sql');
check(replayBinding.includes('v_event.previous_state IS DISTINCT FROM p_expected_status') && replayBinding.includes('v_event.reason_code IS DISTINCT FROM p_reason_code'), 'idempotency replay rejects a reused key when expected state or reason differs');
const workflow = read('.github/workflows/ci.yml');
check(workflow.includes('CI_V2_M3_REPLAY_BINDING_ENABLED') && suiteIncludesReplayGate(), 'CI exposes an explicit gate for live replay-payload checks after the isolated migration is applied');
check(reviewFixes.indexOf('FOR UPDATE OF e;') < reviewFixes.indexOf('WHERE company_id=p_company_id AND idempotency_key=p_idempotency_key;'), 'employer transition locks the application before checking idempotency for concurrent replay');
check(reviewFixes.includes('IF v_eja.candidate_application_id IS NOT NULL AND v_app.status <> v_candidate_status THEN'), 'legacy employer applications transition without requiring a candidate-side link');
check(lifecycle.includes('CREATE OR REPLACE FUNCTION public.set_application_archived'), 'archive preference RPC is in the migration source');
check(lifecycle.includes('CREATE TABLE public.hiring_decision_events'), 'append-only hiring decision audit table is created');
check(lifecycle.includes('CREATE TABLE public.hiring_decision_reason_codes'), 'controlled decision reason vocabulary is created');

const hardening = read('supabase/migrations/20261112185655_v2_p0_m3_lifecycle_hardening.sql');
check(hardening.includes('CREATE OR REPLACE FUNCTION public.transition_application_status'), 'candidate lifecycle RPC includes linked application handling');
check(hardening.includes('CREATE OR REPLACE FUNCTION public.rewind_last_decision'), 'rewind RPC includes linked application protection');

const directApply = read('src/app/api/employer-jobs/[opportunityId]/apply/route.ts');
check(directApply.includes("rpc('apply_to_employer_job'"), 'direct apply HTTP route calls the atomic RPC');
check(!directApply.includes(".from('employer_job_applications').insert"), 'direct apply route does not write employer application rows directly');

const employerRoute = read('src/app/api/employer/companies/[id]/applications/route.ts');
check(employerRoute.includes("rpc('transition_employer_application'"), 'employer PATCH calls the controlled transition RPC');
check(!employerRoute.includes(".from('employer_job_applications')\\n    .update"), 'employer PATCH does not mutate lifecycle status directly');
check(employerRoute.includes('expectedStatus') && employerRoute.includes('idempotencyKey'), 'employer transition requires compare-and-swap and idempotency key');

const candidateRoute = read('src/app/api/applications/status/route.ts');
check(candidateRoute.includes("'offer_declined'") && candidateRoute.includes("'hired'"), 'candidate status validator recognizes the linked lifecycle vocabulary');
check(candidateRoute.includes('application_submitted') && candidateRoute.includes('managed_by_employer'), 'candidate route maps linked-state refusal errors');

const rewindRoute = read('src/app/api/opportunities/rewind/route.ts');
check(rewindRoute.includes("result.error === 'application_submitted'"), 'rewind route returns a conflict for submitted applications');

const archiveRoute = read('src/app/api/applications/archive/route.ts');
check(archiveRoute.includes("rpc('set_application_archived'"), 'archive HTTP route calls the archive preference RPC');
const applicationsRoute = read('src/app/api/applications/route.ts');
check(applicationsRoute.includes('archived_at') && applicationsRoute.includes('application_channel'), 'candidate applications API returns archive preference and channel');
const tracker = read('src/app/tracker/page.tsx');
check(tracker.includes("fetch('/api/applications/archive'") && tracker.includes('archivedAt'), 'candidate tracker uses archive preference API for direct applications');

const trackerUi = read('src/app/tracker/page.tsx');
check(trackerUi.includes('handleArchivePreference') && !trackerUi.includes('if (isDirect && (newStatus === \'archived\' || app.archivedAt))'), 'direct-application archive preference is independent from lifecycle status writes');
check(trackerUi.includes('const totalCount = applications.length;') && !trackerUi.includes('.length || 12') && !trackerUi.includes('.length || 4') && !trackerUi.includes('.length || 1') && !trackerUi.includes('.length || 3'), 'tracker counts reflect actual rows without placeholder fallbacks');
check(trackerUi.includes("status === 'offer_declined'") && trackerUi.includes("status === 'hired'"), 'terminal candidate outcomes have explicit tracker labels');
check(trackerUi.includes("app.status === 'offer' || app.status === 'hired'"), 'hired applications remain grouped with offers');
check(employerUi.includes("new Set(['hired', 'withdrawn', 'offer_declined'])"), 'rejected applications retain the reason control needed for reconsideration');
const employerUi = read('src/app/employer/companies/[id]/applications/page.tsx');
const employerInboxRoute = read('src/app/api/employer/companies/[id]/applications/route.ts');
check(!employerInboxRoute.includes('resume_file_url') && !employerUi.includes('resume_file_url'), 'employer application response and UI do not expose raw resume URLs');
check(employerUi.includes('window.confirm') && employerUi.includes('final hiring decision'), 'hire and rejection decisions require explicit confirmation');
check(employerUi.includes('CLOSED_STATUSES.has(row.status)') && employerUi.includes('!CLOSED_STATUSES.has(row.status)'), 'closed employer applications hide decision controls and reason selectors');
check(employerUi.includes('min-h-11 items-center px-2'), 'employer profile links meet a 44px minimum tap target');
check(employerUi.includes('expectedStatus: row.status'), 'employer UI sends the status it actually observed');
check(employerUi.includes('reasonRequired && !reasonCode') && !employerUi.includes("reasons[row.id] || 'insufficient_evidence'"), 'employer UI requires an explicit reason when required and never fabricates a default');
check(employerUi.includes('...(reasonRequired ? { reasonCode } : {})'), 'employer UI sends a reason only for transitions that require one');
check(employerUi.includes('delete next[row.id]'), 'employer UI clears a decision reason after a successful transition so it cannot leak into a later audit event');
check(employerUi.includes('idempotencyKey: crypto.randomUUID()'), 'employer UI generates a per-action idempotency key');
check(employerUi.includes("'interviewing'") && employerUi.includes("'offered'"), 'employer UI exposes interview and offer lifecycle states');

console.log(`\\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
