import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { changePurchaseAccess } from '@/lib/billing/purchase-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 500;

/**
 * DELETE — soft-revoke a user's purchase access (sets revoked_at; the row
 * and its history are kept). Revoking only stops NEW purchases: it does not
 * cancel an existing subscription or remove Pro. The revoke and its audit
 * row are written together by admin_revoke_purchase_access (migration 033).
 * Revoking access that is not active is a no-op (changed: false).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Typed to the Next 15+ contract (params is a Promise). The installed
  // Next 14.2 passes a plain object instead; awaiting it returns it unchanged,
  // so this works on both and needs no edit on upgrade.
  const { id } = await params;
  let revoker;
  try {
    revoker = await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid user id.' }, { status: 400 });

  let note: string | null = null;
  const raw = await req.text().catch(() => '');
  if (raw) {
    let body: { note?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    if (note && note.length > NOTE_MAX) {
      return NextResponse.json({ error: `The note must be ${NOTE_MAX} characters or fewer.` }, { status: 400 });
    }
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const result = await changePurchaseAccess(db, 'revoke', {
    targetUserId: id.toLowerCase(),
    adminId: revoker.user.id,
    adminEmail: revoker.adminEmail,
    note,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ revoked: true, changed: result.changed });
}
