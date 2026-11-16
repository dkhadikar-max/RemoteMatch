/**
 * Employer-platform audit, P1 #1 (2026-11-13) — isolated-project regression suite for
 * review_employer_job_submission()'s company-suspension/publication race fix
 * (migration 20261113090201_lock_company_on_vacancy_publish.sql).
 *
 * Before the fix, the function locked employer_job_submissions FOR UPDATE but read
 * companies with a plain SELECT — a company suspended via
 * transition_company_verification_with_audit() (migration 047, a fully separate
 * transaction) between that read and the publish decision could still have its
 * vacancy published on the stale "verified" snapshot. The fix adds FOR UPDATE to the
 * companies read, serializing the two functions on the same company row.
 *
 * Calls review_employer_job_submission() and transition_company_verification_with_audit()
 * directly via admin.rpc() — the exact two functions in question — rather than going
 * through HTTP routes, matching the precedent in
 * test/employer-company-accounts-concurrency-isolated-suite.ts section 2/3 for proving a
 * database-level concurrency property.
 *
 * Requires an EXPLICITLY ISOLATED Supabase test project (NEXT_PUBLIC_SUPABASE_URL /
 * NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY) with this migration applied.
 * Never run against production — creates and deletes real auth users, companies, and
 * employer_job_submissions/opportunities rows.
 *
 * Run: npx tsx test/employer-publish-suspension-race-isolated-suite.ts
 */
import { hasRequiredEnv, adminClient, newVerifiedSession } from './helpers/verified-session';

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ PASS: ${m}`); } else { failed++; console.error(`  ✗ FAIL: ${m}`); } }

const admin = adminClient();

function uniqueDomain(tag: string): string {
  return `remotematch-p1-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;
}

async function makeCompany(createdBy: string, status: 'verified' | 'suspended' | 'pending', tag: string): Promise<string> {
  const domain = uniqueDomain(tag);
  const { data, error } = await admin.from('companies').insert({
    legal_name: `P1 Race Test Co (${tag})`,
    official_website: `https://${domain}`,
    official_domain: domain,
    business_email: `hr@${domain}`,
    country_of_registration: 'US',
    verification_status: status,
    created_by: createdBy,
  }).select('id').single();
  if (error || !data) throw new Error(`companies insert failed: ${error?.message}`);
  return data.id as string;
}

async function makeSubmission(companyId: string, createdBy: string, tag: string): Promise<string> {
  const { data, error } = await admin.from('employer_job_submissions').insert({
    company_id: companyId,
    created_by: createdBy,
    title: `P1 Race Test Role (${tag})`,
    description: 'Isolated-project P1 #1 regression fixture. '.repeat(3),
    employment_type: 'Full-time',
    remote_type: 'Remote',
    application_url: `https://example.com/apply/${tag}-${Date.now()}`,
    status: 'submitted',
    submitted_at: new Date().toISOString(),
  }).select('id').single();
  if (error || !data) throw new Error(`employer_job_submissions insert failed: ${error?.message}`);
  return data.id as string;
}

async function reviewSubmission(submissionId: string, adminId: string, action: 'mark_under_review' | 'approve_publish' | 'reject', reason: string) {
  const { data, error } = await admin.rpc('review_employer_job_submission', {
    p_submission_id: submissionId,
    p_admin_id: adminId,
    p_admin_email: 'p1-race-test-admin@example.com',
    p_action: action,
    p_reason: reason,
  });
  if (error) throw new Error(`review_employer_job_submission RPC failed: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) as { ok: boolean; new_status: string | null; opportunity_id: string | null };
}

async function transitionCompany(companyId: string, expectedStatus: string, newStatus: string, adminId: string) {
  const { data, error } = await admin.rpc('transition_company_verification_with_audit', {
    p_company_id: companyId,
    p_expected_status: expectedStatus,
    p_new_status: newStatus,
    p_reviewed_by: 'p1-race-test-admin@example.com',
    p_reason: 'P1 race regression fixture',
    p_admin_id: adminId,
    p_admin_email: 'p1-race-test-admin@example.com',
    p_audit_action: newStatus === 'suspended' ? 'company_suspend' : 'company_verify',
  });
  if (error) throw new Error(`transition_company_verification_with_audit RPC failed: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) as { transitioned: boolean; verification_status: string | null };
}

async function main() {
  console.log('='.repeat(78));
  console.log('EMPLOYER P1 #1 — publication/suspension race fix (isolated project only)');
  console.log('='.repeat(78));

  if (!hasRequiredEnv()) {
    console.error('Supabase env not all set — this suite requires a live isolated project and refuses to silently no-op.');
    process.exitCode = 1;
    return;
  }

  const companyCleanup: string[] = [];
  const userCleanup: string[] = [];

  try {
    const actor = await newVerifiedSession();
    userCleanup.push(actor.userId);
    const adminId = actor.userId; // RPCs take a bare admin id/email — any real profile id suffices for this fixture

    // --- 1. Verified company CAN publish ---
    console.log('\n1. A verified company can publish');
    const okCompanyId = await makeCompany(actor.userId, 'verified', 'ok');
    companyCleanup.push(okCompanyId);
    const okSubmissionId = await makeSubmission(okCompanyId, actor.userId, 'ok');
    const okResult = await reviewSubmission(okSubmissionId, adminId, 'approve_publish', 'verified company, should publish');
    assert(okResult.ok === true && okResult.new_status === 'published', `publish succeeds for a verified company (got ok=${okResult.ok}, status=${okResult.new_status})`);
    assert(!!okResult.opportunity_id, 'a real opportunity id is returned on success');

    // --- 2. Suspended company CANNOT publish ---
    console.log('\n2. A suspended company cannot publish');
    const suspendedCompanyId = await makeCompany(actor.userId, 'suspended', 'susp');
    companyCleanup.push(suspendedCompanyId);
    const suspendedSubmissionId = await makeSubmission(suspendedCompanyId, actor.userId, 'susp');
    const suspendedResult = await reviewSubmission(suspendedSubmissionId, adminId, 'approve_publish', 'suspended company, must reject');
    assert(suspendedResult.ok === false, `publish is rejected for an already-suspended company (got ok=${suspendedResult.ok})`);
    const { data: suspendedSubRow } = await admin.from('employer_job_submissions').select('status, published_opportunity_id').eq('id', suspendedSubmissionId).single();
    assert(suspendedSubRow?.status !== 'published' && !suspendedSubRow?.published_opportunity_id, 'the submission was never marked published and has no opportunity id');

    // --- 3. Concurrent publication AND suspension: the actual race ---
    console.log('\n3. Genuine concurrent publish + suspend on the SAME company — the fix under test');
    //
    // CORRECTED INVARIANT (fixed after an initial run against this live isolated project
    // caught my own first version of this assertion being WRONG, not the migration):
    // under the FOR UPDATE fix, the two functions fully serialize on the companies row, so
    // there are exactly TWO legitimate final states, and "the company ends up suspended AND
    // this submission ends up published" is NOT itself a violation --
    //   (a) publish's lock is granted first: it reads a genuinely fresh 'verified' status
    //       (not stale -- nothing has changed it yet), publishes, commits. Suspend's UPDATE
    //       then runs against the now-unlocked row and still succeeds (suspension is a
    //       separate, always-valid admin action; it only has to apply to a comparison
    //       against the row's CURRENT state when it runs). Final state: suspended + published
    //       -- correct, not stale.
    //   (b) suspend's lock is granted first: it commits the transition. Publish's FOR UPDATE
    //       then reads 'suspended' -- fresh, not stale -- and correctly rejects. Final state:
    //       suspended + NOT published.
    // What the fix actually rules out (and what a plain, uncontrolled Promise.all against a
    // real hosted project with real network jitter cannot reliably force open to prove
    // either way) is a THIRD state: publish succeeding on a STALE pre-suspension read after
    // suspend has already committed. That property is proven deterministically, with
    // provable timing (an injected delay forcing the exact dangerous window open, plus a
    // negative-control run against the pre-fix function body showing it reliably fails),
    // in the disposable local-Postgres trials reported alongside this suite -- not re-proven
    // here. This isolated-project run instead confirms the migration behaves correctly
    // against the real schema/constraints/latency: suspension always succeeds, and the
    // outcome is always one of the two legitimate states above, never a third.
    const raceCompanyId = await makeCompany(actor.userId, 'verified', 'race');
    companyCleanup.push(raceCompanyId);
    const raceSubmissionId = await makeSubmission(raceCompanyId, actor.userId, 'race');

    const [publishOutcome, suspendOutcome] = await Promise.all([
      reviewSubmission(raceSubmissionId, adminId, 'approve_publish', 'race: publish side'),
      transitionCompany(raceCompanyId, 'verified', 'suspended', adminId),
    ]);

    const { data: raceCompanyRow } = await admin.from('companies').select('verification_status').eq('id', raceCompanyId).single();
    const { data: raceSubRow } = await admin.from('employer_job_submissions').select('status, published_opportunity_id').eq('id', raceSubmissionId).single();

    console.log(`  (interleaving observed: publish ok=${publishOutcome.ok}, suspend transitioned=${suspendOutcome.transitioned}, final company status=${raceCompanyRow?.verification_status}, final submission status=${raceSubRow?.status})`);

    assert(
      suspendOutcome.transitioned === true && raceCompanyRow?.verification_status === 'suspended',
      'the suspension itself always succeeds (nothing about the publish path can block a legitimate suspension)'
    );
    const outcomeIsLegitimateA = raceSubRow?.status === 'published' && !!raceSubRow.published_opportunity_id && publishOutcome.ok === true;
    const outcomeIsLegitimateB = raceSubRow?.status !== 'published' && !raceSubRow?.published_opportunity_id && publishOutcome.ok === false;
    assert(outcomeIsLegitimateA || outcomeIsLegitimateB, 'the final state matches exactly one of the two legitimate serialized orderings, never an inconsistent third state');

    // --- 4. Existing review/rejection/idempotency behavior is unchanged ---
    console.log('\n4. mark_under_review, reject, and re-publish idempotency are unchanged');
    const lifecycleCompanyId = await makeCompany(actor.userId, 'verified', 'lifecycle');
    companyCleanup.push(lifecycleCompanyId);
    const lifecycleSubmissionId = await makeSubmission(lifecycleCompanyId, actor.userId, 'lifecycle');

    const underReview = await reviewSubmission(lifecycleSubmissionId, adminId, 'mark_under_review', 'moving to review');
    assert(underReview.ok === true && underReview.new_status === 'under_review', `mark_under_review succeeds from submitted (got ok=${underReview.ok}, status=${underReview.new_status})`);

    const rejected = await reviewSubmission(lifecycleSubmissionId, adminId, 'reject', 'does not meet quality bar');
    assert(rejected.ok === true && rejected.new_status === 'rejected', `reject succeeds from under_review (got ok=${rejected.ok}, status=${rejected.new_status})`);

    const publishAfterReject = await reviewSubmission(lifecycleSubmissionId, adminId, 'approve_publish', 'should be rejected — wrong state');
    assert(publishAfterReject.ok === false, 'publish is rejected for a submission already in rejected status (state machine unaffected by the fix)');

    const rePublishOk = await reviewSubmission(okSubmissionId, adminId, 'approve_publish', 're-publish attempt on an already-published submission');
    assert(rePublishOk.ok === false, 'a second publish attempt on an already-published submission is rejected (idempotency unaffected by the fix)');
  } finally {
    console.log('\nCleanup…');
    for (const companyId of companyCleanup) {
      const { data: subs } = await admin.from('employer_job_submissions').select('id, published_opportunity_id').eq('company_id', companyId);
      for (const s of subs ?? []) {
        if (s.published_opportunity_id) {
          try { await admin.from('opportunities').delete().eq('id', s.published_opportunity_id); } catch { /* best-effort */ }
        }
      }
      try {
        const submissionIds = (subs ?? []).map((s) => s.id);
        if (submissionIds.length > 0) await admin.from('employer_job_review_events').delete().in('submission_id', submissionIds);
      } catch { /* best-effort */ }
      try { await admin.from('employer_job_submissions').delete().eq('company_id', companyId); } catch { /* best-effort */ }
      try { await admin.from('admin_audit_log').delete().eq('target_type', 'company').eq('target_id', companyId); } catch { /* best-effort */ }
      try { await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
    }
    for (const id of userCleanup) {
      try { await admin.auth.admin.deleteUser(id); } catch { /* best-effort */ }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});
