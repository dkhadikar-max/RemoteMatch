import { NextRequest, NextResponse } from 'next/server';
import { runResumeQuotaReconciliation, verifyReconciliationSecret } from '@/lib/resume/quota-reconciliation';

/**
 * POST /api/resume/reconcile-quota[?dryRun=1]
 *
 * Requires RESUME_QUOTA_RECONCILE_SECRET (fail-closed if unset, same discipline as
 * /api/opportunities/sync's INGESTION_SYNC_SECRET check). Meant to be triggered by a scheduled
 * job (Railway cron or an external scheduler), not by product/user traffic -- this is why the
 * sweep itself (reconcile_resume_quota_orphans()) is service-role-only, not a per-user RPC.
 *
 * dryRun=1 reports candidates without writing anything -- use this for the first manual runs
 * before trusting the live-write path.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || req.headers.get('X-Internal-Secret');
  if (!verifyReconciliationSecret(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized: internal secret required for resume quota reconciliation.' },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get('dryRun') === '1';

  const summary = await runResumeQuotaReconciliation(dryRun);
  if (!summary.ran) {
    return NextResponse.json({ success: false, error: summary.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, ...summary });
}
