import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { escapeLikeWildcards } from '@/lib/admin/escape-like-wildcards';

const PAGE_SIZE = 30;

/** Escapes `\`, `%`, and `_` so a caller-supplied search term is matched
 *  literally by Postgres ILIKE rather than having `%`/`_` read as its
 *  wildcard characters (`\` must be escaped first, or escaping `%`/`_`
 *  into `\%`/`\_` would itself introduce new unescaped backslashes). */
export function escapeLikeWildcards(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * GET /api/admin/company-verifications — Direct Employer Supply, Phase 1
 * admin review queue. Deliberately not named "/api/admin/employers" — that
 * path already exists (allowlist_employers, the unrelated ATS-scrape
 * registry) — see the Phase 1 plan's Q1.
 */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const verificationStatus = searchParams.get('verificationStatus');
  // Two separate single-column filters rather than an `.or()` — this
  // codebase's other admin list routes (opportunities, employers) never
  // interpolate caller-supplied text into PostgREST's `.or()` filter syntax,
  // and a comma/paren in `q` would otherwise be read as filter syntax, not
  // a literal search term.
  const q = searchParams.get('q');
  const domain = searchParams.get('domain');

  let query = admin
    .from('companies')
    .select(
      'id, legal_name, official_domain, business_email, verification_status, verification_reviewed_at, verification_reviewed_by, created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  if (verificationStatus) query = query.eq('verification_status', verificationStatus);
  // escapeLikeWildcards (2026-11-05 review finding fix): a literal `%` or
  // `_` the admin typed is matched as a literal character, not a SQL LIKE
  // wildcard — the surrounding `%...%` added here are the only wildcards.
  if (q) query = query.ilike('legal_name', `%${escapeLikeWildcards(q)}%`);
  if (domain) query = query.ilike('official_domain', `%${escapeLikeWildcards(domain)}%`);

  const from = (page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ companies: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
}
