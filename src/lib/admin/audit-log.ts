import { getSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Closed vocabulary, matching admin_audit_log's CHECK constraints exactly
 * (migration 029) — extend both together, never widen either to free text.
 */
export type AdminAuditAction =
  | 'c6_promote'
  | 'c6_reject'
  | 'opportunity_force_expire'
  | 'admin_grant'
  | 'admin_revoke';

export type AdminAuditTargetType = 'discovered_company' | 'opportunity' | 'admin_user';

export interface RecordAdminActionParams {
  adminId: string;
  adminEmail: string;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  targetId: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * The one writer for admin_audit_log. Deliberately AWAITED by every caller
 * (unlike ai_call_events'/funnel_events' fire-and-forget pattern) — audit
 * correctness for privileged mutations matters more than shaving one round
 * trip, and a caller needs to know if the log write itself failed so it can
 * surface that to the admin rather than silently losing the record.
 *
 * Never throws into a caller that has already completed the underlying
 * mutation — a logging failure must not make an already-successful C6
 * promotion or opportunity change look like it failed. Instead returns
 * { ok: false, error } so the route can report "action succeeded, but the
 * audit record failed to write" rather than staying silent about it.
 */
export async function recordAdminAction(
  params: RecordAdminActionParams
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = getSupabaseAdminClient();
  if (!admin) return { ok: false, error: 'admin_client_not_configured' };

  const { error } = await admin.from('admin_audit_log').insert({
    admin_id: params.adminId,
    admin_email: params.adminEmail,
    action: params.action,
    target_type: params.targetType,
    target_id: params.targetId,
    before_state: params.beforeState ?? null,
    after_state: params.afterState ?? null,
    reason: params.reason ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
