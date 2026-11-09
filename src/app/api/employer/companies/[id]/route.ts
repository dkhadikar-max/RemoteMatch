import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedEmployer } from '@/lib/auth/get-authenticated-employer';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';
import { EMPLOYER_INDUSTRIES, EMPLOYER_COMPANY_SIZES } from '@/lib/employer/taxonomy';

const COMPANY_COLUMNS =
  'id, legal_name, official_website, official_domain, business_email, country_of_registration, ' +
  'registration_number, linkedin_url, industry, company_size, description, headquarters, ' +
  'verification_status, verification_reason, created_at, updated_at';

/** GET — the caller's own view of a company they're a member of: the
 *  company record plus their own membership row. 404s (never 403) for a
 *  company the caller doesn't belong to, or one that doesn't exist at all —
 *  getAuthenticatedEmployer() doesn't distinguish the two (Phase 1 plan Q7). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  let employer;
  try {
    employer = await getAuthenticatedEmployer(req, params.id);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  try {
    const res = must(
      await admin.from('companies').select(COMPANY_COLUMNS).eq('id', employer.companyId).maybeSingle(),
      'companies'
    );
    if (!res.data) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json({ company: res.data, role: employer.role });
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 5000;

/**
 * Editable field set (Phase 1 plan §4.1 / Q6): cosmetic-only. Deliberately
 * excludes legal_name, official_website, official_domain, business_email,
 * registration_number, country_of_registration, and verification_status —
 * none of those have an edit route at all in Phase 1, so an edit here can
 * never force or avoid re-review.
 */
interface PatchBody {
  description?: string | null;
  headquarters?: string | null;
  industry?: string | null;
  companySize?: string | null;
  linkedinUrl?: string | null;
}

function isOptionalNullableString(v: unknown, maxLen: number): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= maxLen);
}

function isValidPatchBody(body: unknown): body is PatchBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const allowedKeys = ['description', 'headquarters', 'industry', 'companySize', 'linkedinUrl'];
  if (Object.keys(b).some((k) => !allowedKeys.includes(k))) return false;
  return (
    isOptionalNullableString(b.description, MAX_LONG_TEXT) &&
    isOptionalNullableString(b.headquarters, MAX_TEXT) &&
    isOptionalNullableString(b.industry, MAX_TEXT) && (b.industry === undefined || b.industry === null || (EMPLOYER_INDUSTRIES as readonly string[]).includes(String(b.industry))) &&
    isOptionalNullableString(b.companySize, MAX_TEXT) && (b.companySize === undefined || b.companySize === null || (EMPLOYER_COMPANY_SIZES as readonly string[]).includes(String(b.companySize))) &&
    isOptionalNullableString(b.linkedinUrl, MAX_TEXT)
  );
}

/** PATCH — edit the cosmetic-only profile fields. Requires `owner` or
 *  `admin` membership; a plain `member` may read (GET) but not write. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let employer;
  try {
    employer = await getAuthenticatedEmployer(req, params.id);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (employer.role !== 'owner' && employer.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: only an owner or admin may edit the company profile.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isValidPatchBody(body)) {
    return NextResponse.json({ error: 'Invalid or disallowed field in request body.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('description' in body) update.description = body.description?.trim() || null;
  if ('headquarters' in body) update.headquarters = body.headquarters?.trim() || null;
  if ('industry' in body) update.industry = body.industry?.trim() || null;
  if ('companySize' in body) update.company_size = body.companySize?.trim() || null;
  if ('linkedinUrl' in body) update.linkedin_url = body.linkedinUrl?.trim() || null;

  const { data, error } = await admin
    .from('companies')
    .update(update)
    .eq('id', employer.companyId)
    .select(COMPANY_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ company: data });
}
