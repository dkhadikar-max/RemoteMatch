import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

export async function GET(req: NextRequest) {
  let user;
  try { ({ user } = await getAuthenticatedUser(req)); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const memberships = must(await db.from('company_members')
      .select('company_id, role').eq('profile_id', user.id).eq('status', 'active'), 'company_members').data ?? [];
    if (!memberships.length) return NextResponse.json({ companies: [] });
    const ids = memberships.map((m: { company_id: string }) => m.company_id);
    const companies = must(await db.from('companies')
      .select('id,legal_name,official_domain,verification_status,verification_reason,created_at')
      .in('id', ids).order('created_at', { ascending: false }), 'companies').data ?? [];
    return NextResponse.json({ companies: companies.map((c: Record<string, unknown>) => ({
      ...c, role: memberships.find((m: { company_id: string }) => m.company_id === c.id)?.role,
    })) });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
}
