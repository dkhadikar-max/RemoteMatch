import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { changePurchaseAccess } from '@/lib/billing/purchase-access';
import { isPurchaseAllowed, purchaseAllowlist } from '@/lib/razorpay';
import { likeLiteral } from '@/lib/supabase/query-helpers';

const LIST_LIMIT = 1000;
const NOTE_MAX = 500;
const EMAIL_BATCH = 100;

/**
 * GET — every purchase-access row, active and revoked, with the account's
 * email, plus whether the DEPLOYMENT allowlist (RAZORPAY_ALLOWLIST_USER_IDS)
 * would also let that user through. A purchase needs both, so an active
 * grant the deployment allowlist blocks is shown as such. The allowlist's
 * ids themselves are never returned — only its mode and a per-row yes/no.
 */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data: rows, error } = await db
    .from('billing_purchase_access')
    .select('user_id, granted_by_email, granted_at, revoked_at, revoked_by_email, note')
    .order('granted_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return NextResponse.json({ error: 'Could not load purchase access.', detail: error.message }, { status: 500 });

  const ids = (rows ?? []).map((r) => r.user_id as string);
  const emails = new Map<string, string>();
  // Batched: one .in() over up to 1,000 ids would make an over-long request URL.
  for (let i = 0; i < ids.length; i += EMAIL_BATCH) {
    const { data: profiles, error: pErr } = await db.from('profiles').select('id, email').in('id', ids.slice(i, i + EMAIL_BATCH));
    if (pErr) return NextResponse.json({ error: 'Could not load account emails.', detail: pErr.message }, { status: 500 });
    for (const p of profiles ?? []) emails.set(p.id as string, (p.email as string) ?? '');
  }

  return NextResponse.json({
    deploymentAllowlist: { mode: purchaseAllowlist.mode },
    truncated: ids.length === LIST_LIMIT,
    access: (rows ?? []).map((r) => ({
      ...r,
      email: emails.get(r.user_id as string) ?? null,
      active: r.revoked_at === null,
      deploymentAllows: isPurchaseAllowed(purchaseAllowlist, r.user_id as string),
    })),
  });
}

/**
 * POST — grant purchase access to an EXISTING RemoteMatch account, named by
 * email. The target id is resolved here, server-side, from that email — a
 * client-supplied user id is never trusted. The grant and its audit row are
 * written together by admin_grant_purchase_access (migration 033); success
 * is reported only when that transaction committed.
 */
export async function POST(req: NextRequest) {
  let granter;
  try {
    granter = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  let body: { email?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) return NextResponse.json({ error: 'An email is required.' }, { status: 400 });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > NOTE_MAX) {
    return NextResponse.json({ error: `The note must be ${NOTE_MAX} characters or fewer.` }, { status: 400 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data: matches, error: lookupErr } = await db
    .from('profiles')
    .select('id, email')
    .ilike('email', likeLiteral(email))
    .limit(2);
  if (lookupErr) return NextResponse.json({ error: 'Could not look up that account.', detail: lookupErr.message }, { status: 500 });
  const exact = (matches ?? []).filter((p) => ((p.email as string) ?? '').toLowerCase() === email);
  if (exact.length === 0) return NextResponse.json({ error: 'No RemoteMatch account exists with that email.' }, { status: 404 });
  if (exact.length > 1) return NextResponse.json({ error: 'More than one account matches that email; nothing was changed.' }, { status: 409 });
  const target = exact[0];

  const result = await changePurchaseAccess(db, 'grant', {
    targetUserId: target.id as string,
    adminId: granter.user.id,
    adminEmail: granter.adminEmail,
    note,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    granted: true,
    changed: result.changed,
    userId: target.id,
    email: target.email,
    deploymentAllows: isPurchaseAllowed(purchaseAllowlist, target.id as string),
  });
}
