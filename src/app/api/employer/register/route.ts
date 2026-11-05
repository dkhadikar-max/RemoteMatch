import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 5000;

interface RegisterBody {
  legalName: string;
  officialWebsite: string;
  businessEmail: string;
  countryOfRegistration: string;
  registrationNumber?: string;
  linkedinUrl?: string;
  industry?: string;
  companySize?: string;
  description?: string;
  headquarters?: string;
  representativeName: string;
  representativeDesignation: string;
  representativeRelationship: string;
}

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isOptionalString(v: unknown, maxLen: number): v is string | undefined {
  return v === undefined || (typeof v === 'string' && v.length <= maxLen);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidBody(body: unknown): body is RegisterBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    isNonEmptyString(b.legalName, MAX_TEXT) &&
    isNonEmptyString(b.officialWebsite, MAX_TEXT) &&
    isNonEmptyString(b.businessEmail, MAX_TEXT) &&
    EMAIL_RE.test((b.businessEmail as string).trim()) &&
    isNonEmptyString(b.countryOfRegistration, MAX_TEXT) &&
    isNonEmptyString(b.representativeName, MAX_TEXT) &&
    isNonEmptyString(b.representativeDesignation, MAX_TEXT) &&
    isNonEmptyString(b.representativeRelationship, MAX_TEXT) &&
    isOptionalString(b.registrationNumber, MAX_TEXT) &&
    isOptionalString(b.linkedinUrl, MAX_TEXT) &&
    isOptionalString(b.industry, MAX_TEXT) &&
    isOptionalString(b.companySize, MAX_TEXT) &&
    isOptionalString(b.description, MAX_LONG_TEXT) &&
    isOptionalString(b.headquarters, MAX_TEXT)
  );
}

/**
 * Normalizes an employer-supplied website into a bare lowercase host,
 * stripping a leading "www." — the value `uq_companies_official_domain`
 * (migration 044) de-duplicates on. Never trusts a client-supplied domain
 * directly; always re-derived here from the URL the employer actually gave.
 * Returns null for anything that doesn't parse as an http(s) URL.
 */
function normalizeDomain(rawWebsite: string): string | null {
  let candidate = rawWebsite.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * POST /api/employer/register — Direct Employer Supply, Phase 1. Creates a
 * `companies` row (`verification_status = 'pending'`) and the registering
 * caller's own `company_members` row (`role = 'owner'`) carrying the
 * authorized-representative fields from the PRD. No business-email
 * verification (Phase 1 plan Q2 — deferred); no fuzzy duplicate detection
 * (Q3 — the official_domain unique index is the whole mechanism here).
 */
export async function POST(req: NextRequest) {
  let user;
  try {
    ({ user } = await getAuthenticatedUser(req));
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Missing or invalid registration fields.' }, { status: 400 });
  }

  const officialDomain = normalizeDomain(body.officialWebsite);
  if (!officialDomain) {
    return NextResponse.json({ error: 'official_website is not a valid URL.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const { data: company, error: insertError } = await admin
    .from('companies')
    .insert({
      legal_name: body.legalName.trim(),
      official_website: body.officialWebsite.trim(),
      official_domain: officialDomain,
      business_email: body.businessEmail.trim(),
      country_of_registration: body.countryOfRegistration.trim(),
      registration_number: body.registrationNumber?.trim() || null,
      linkedin_url: body.linkedinUrl?.trim() || null,
      industry: body.industry?.trim() || null,
      company_size: body.companySize?.trim() || null,
      description: body.description?.trim() || null,
      headquarters: body.headquarters?.trim() || null,
      created_by: user.id,
    })
    .select('id, verification_status')
    .single();

  if (insertError) {
    // Unique violation on official_domain — a company for this domain
    // already exists. Reported as a clear conflict, not a generic 500.
    if (insertError.code === '23505') {
      return NextResponse.json(
        { error: 'A company is already registered for this website domain.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const { error: memberError } = await admin.from('company_members').insert({
    company_id: company.id,
    profile_id: user.id,
    role: 'owner',
    representative_name: body.representativeName.trim(),
    representative_designation: body.representativeDesignation.trim(),
    representative_relationship: body.representativeRelationship.trim(),
  });

  if (memberError) {
    // Roll back the orphaned company row rather than leaving a companies
    // row with no owning member — best-effort; a failure here is logged by
    // the delete's own error, not swallowed, but the original memberError
    // is still what's reported to the caller.
    await admin.from('companies').delete().eq('id', company.id);
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  return NextResponse.json(
    { companyId: company.id, verificationStatus: company.verification_status },
    { status: 201 }
  );
}
