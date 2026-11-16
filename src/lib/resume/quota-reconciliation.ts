/**
 * Resume Intelligence (PR B) — durable reconciliation sweep for orphaned per-attempt quota
 * reservations (migration 042, Stage 6 follow-up, 2026-11-02).
 *
 * This module is the ONLY call site for reconcile_resume_quota_orphans() -- a service-role-only
 * RPC that scans across every user's resume_quota_events for a 'reserved' event with no matching
 * 'refunded' event, where the attempt is either superseded or abandoned, and refunds it (see the
 * migration's own header comment for the exact 3 eligibility branches and why it needs the
 * service-role admin client rather than the client-facing refund_resume_analysis() RPC).
 *
 * Triggered only by POST /api/resume/reconcile-quota, itself secret-gated the same way
 * /api/opportunities/sync is (an external scheduler, not product/user traffic) -- see
 * verifyReconciliationSecret() below.
 */
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export function verifyReconciliationSecret(authHeader: string | null): boolean {
  const secret = process.env.RESUME_QUOTA_RECONCILE_SECRET;
  if (!secret || !authHeader) return false;

  const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  const secretBuf = Buffer.from(secret);
  const candidateBuf = Buffer.from(candidate);
  if (secretBuf.length !== candidateBuf.length) return false;

  return timingSafeEqual(secretBuf, candidateBuf);
}

export interface ReconciliationRow {
  analysisId: string;
  attemptNumber: number;
  reconciled: boolean;
  detail: string;
}

export interface ReconciliationSummary {
  ran: boolean;
  dryRun: boolean;
  candidatesFound: number;
  reconciled: number;
  alreadyRefunded: number;
  errors: number;
  rows: ReconciliationRow[];
  error?: string;
}

/** Runs the sweep once. `dryRun: true` reports candidates without writing anything (every row
 *  comes back with `detail: 'dry_run'`, `reconciled: false`) -- useful for a first manual run
 *  before trusting the live-write path, or for monitoring/alerting on candidate volume without
 *  acting on it. Never throws: a transport/RPC-level failure is reported in `.error`, matching
 *  this project's own `{data, error}`-checking convention elsewhere (Finding A). */
export async function runResumeQuotaReconciliation(dryRun = false): Promise<ReconciliationSummary> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { ran: false, dryRun, candidatesFound: 0, reconciled: 0, alreadyRefunded: 0, errors: 0, rows: [], error: 'Supabase admin client is not configured' };
  }

  const { data, error } = await admin.rpc('reconcile_resume_quota_orphans', { p_dry_run: dryRun });
  if (error) {
    return { ran: false, dryRun, candidatesFound: 0, reconciled: 0, alreadyRefunded: 0, errors: 0, rows: [], error: error.message };
  }

  const rawRows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{
    analysis_id: string; attempt_number: number; reconciled: boolean; detail: string;
  }>;
  const rows: ReconciliationRow[] = rawRows.map((r) => ({
    analysisId: r.analysis_id, attemptNumber: r.attempt_number, reconciled: r.reconciled, detail: r.detail,
  }));

  return {
    ran: true,
    dryRun,
    candidatesFound: rows.length,
    reconciled: rows.filter((r) => r.reconciled).length,
    alreadyRefunded: rows.filter((r) => r.detail === 'already_refunded').length,
    errors: rows.filter((r) => r.detail.startsWith('error:')).length,
    rows,
  };
}
