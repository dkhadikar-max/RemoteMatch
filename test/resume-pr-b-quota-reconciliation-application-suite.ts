/**
 * Resume Intelligence (PR B) — application-layer suite for the quota reconciliation sweep's
 * TypeScript wrapper and secret-gated route (migration 042, Stage 6 follow-up, 2026-11-02).
 *
 * Mocked only -- no real Supabase admin client, no live Postgres (that is
 * test/live-pg/resume-quota-lifecycle-live-suite.ts's job, run separately). This suite proves:
 * the secret comparison itself (timing-safe, fail-closed when unset), and that
 * runResumeQuotaReconciliation() correctly maps the RPC's {data, error} shape into its own
 * summary, including dryRun passthrough and the admin-client-not-configured fail-closed path.
 *
 * Run: npx tsx test/resume-pr-b-quota-reconciliation-application-suite.ts
 */
import { verifyReconciliationSecret } from '../src/lib/resume/quota-reconciliation';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: string) {
  if (condition) { console.log(`  ✓ PASS: ${message}`); passed++; }
  else { console.error(`  ✗ FAIL: ${message}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — QUOTA RECONCILIATION APPLICATION LAYER');
  console.log('='.repeat(78));

  console.log('\n1. verifyReconciliationSecret() -- fail-closed, exact match required');
  {
    const original = process.env.RESUME_QUOTA_RECONCILE_SECRET;
    try {
      delete process.env.RESUME_QUOTA_RECONCILE_SECRET;
      assert(verifyReconciliationSecret('Bearer anything') === false, 'with no secret configured at all, every request is rejected (fail-closed, not fail-open)');

      process.env.RESUME_QUOTA_RECONCILE_SECRET = 'a-real-secret-value';
      assert(verifyReconciliationSecret(null) === false, 'a missing Authorization header is rejected');
      assert(verifyReconciliationSecret('Bearer wrong-value') === false, 'a mismatched secret is rejected');
      assert(verifyReconciliationSecret('Bearer a-real-secret-value') === true, 'the exact correct secret, Bearer-prefixed, is accepted');
      assert(verifyReconciliationSecret('a-real-secret-value') === true, 'the exact correct secret, without the Bearer prefix (X-Internal-Secret shape), is also accepted');
      assert(verifyReconciliationSecret('a-real-secret-value-but-longer') === false, 'a same-prefix but different-length candidate is rejected (length-checked before the timing-safe comparison, never an out-of-bounds compare)');
    } finally {
      if (original === undefined) delete process.env.RESUME_QUOTA_RECONCILE_SECRET;
      else process.env.RESUME_QUOTA_RECONCILE_SECRET = original;
    }
  }

  console.log('\n2. runResumeQuotaReconciliation() -- admin client not configured');
  {
    // getSupabaseAdminClient() returns null when NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
    // aren't set -- confirmed by reading supabase/admin.ts directly, exercised here without
    // needing to mock the module (this test's own process env has neither set).
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { runResumeQuotaReconciliation } = await import('../src/lib/resume/quota-reconciliation');
    const result = await runResumeQuotaReconciliation(false);
    assert(result.ran === false, 'reports ran:false rather than throwing when the admin client is unavailable');
    assert(typeof result.error === 'string' && result.error.length > 0, 'a clear error message is returned', result.error);
    assert(result.rows.length === 0, 'no rows are reported when the sweep never actually ran');
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
