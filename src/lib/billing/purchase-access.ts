import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Admin-controlled Pro purchase access (migration 033). A user may START a
 * purchase only when BOTH the deployment-level RAZORPAY_ALLOWLIST_USER_IDS
 * (src/lib/razorpay.ts) permits them AND they hold an active row in
 * billing_purchase_access. This module is the second half.
 *
 * Every function here takes the SERVICE-ROLE client: the table and the two
 * write functions are revoked from anon/authenticated, so no browser session
 * can read or change anyone's access — including its own.
 */

/**
 * True only when the user has an active grant. Fails CLOSED: a missing table,
 * a query error or a thrown exception all return false — never "allowed".
 */
export async function hasActivePurchaseGrant(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('billing_purchase_access')
      .select('user_id')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      console.error('[purchase-access] grant lookup failed; treating as no access', error.code, error.message);
      return false;
    }
    return Boolean(data);
  } catch (err) {
    console.error('[purchase-access] grant lookup threw; treating as no access', (err as Error).message);
    return false;
  }
}

export interface PurchaseAccessChange {
  targetUserId: string;
  adminId: string;
  adminEmail: string;
  note?: string | null;
}

export type PurchaseAccessChangeResult =
  | { ok: true; changed: boolean; active: boolean }
  | { ok: false; status: 403 | 404 | 500; error: string };

/**
 * Grant or revoke through the transactional database functions, which change
 * access and write the admin_audit_log row together (both commit or neither
 * does). A repeat of the current state is a no-op: changed=false, no audit
 * row. Success is reported ONLY when the function itself returned a result.
 */
export async function changePurchaseAccess(
  db: SupabaseClient,
  kind: 'grant' | 'revoke',
  change: PurchaseAccessChange
): Promise<PurchaseAccessChangeResult> {
  const fn = kind === 'grant' ? 'admin_grant_purchase_access' : 'admin_revoke_purchase_access';
  const { data, error } = await db.rpc(fn, {
    p_target_user_id: change.targetUserId,
    p_admin_id: change.adminId,
    p_admin_email: change.adminEmail,
    p_note: change.note ?? null,
  });
  if (error) {
    console.error(`[purchase-access] ${fn} failed; nothing changed`, error.code, error.message);
    // The function's own "acting user is not an active admin" (raised inside
    // the transaction) — matched on its message too, so a permission error
    // from the database itself is not mistaken for it. 23503 = the target
    // account does not exist.
    if (error.code === '42501' && /not an active admin/.test(error.message)) return { ok: false, status: 403, error: 'Your admin access is no longer active.' };
    if (error.code === '23503') return { ok: false, status: 404, error: 'No RemoteMatch account exists for that user.' };
    return { ok: false, status: 500, error: 'The change was not saved. Nothing was changed.' };
  }
  const result = data as { changed?: unknown; active?: unknown } | null;
  if (typeof result?.changed !== 'boolean' || typeof result?.active !== 'boolean') {
    return { ok: false, status: 500, error: 'Unexpected response from the database. Re-check the current state.' };
  }
  return { ok: true, changed: result.changed, active: result.active };
}
