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

// RFC 2606 / commonly-reserved non-public TLDs and host suffixes — rejected
// outright rather than accepted as a "company domain". Not a public-suffix
// list (no such dependency exists in this project, and adding one is more
// than this validation needs — see the 2026-11-05 review finding this
// fixes): this is a denylist of the obvious non-public cases, matched to
// the same strictness level as this codebase's existing hostname check in
// src/lib/profile-links/validate.ts (`!hostname.includes('.')`), not a
// claim that every remaining accepted hostname is a real, resolvable domain.
const NON_PUBLIC_TLDS = new Set(['local', 'localhost', 'internal', 'test', 'example', 'invalid']);

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Normalizes an employer-supplied website into a bare lowercase host,
 * stripping a leading "www." — the value `uq_companies_official_domain`
 * (migration 044) de-duplicates on. Never trusts a client-supplied domain
 * directly; always re-derived here from the URL the employer actually gave.
 *
 * Returns null for anything that doesn't parse as an http(s) URL, OR that
 * parses but isn't a plausible public company domain: a bare single-label
 * host ("acme", "localhost" itself), an IPv4/IPv6 literal, or a host whose
 * last label is a reserved non-public TLD (`NON_PUBLIC_TLDS`). This does
 * NOT verify the employer actually owns/controls the domain — that remains
 * a separate, not-yet-built future requirement (Phase 1 plan Q2's business-
 * email verification is the closest thing today, and it's deferred too).
 */
export function normalizeDomain(rawWebsite: string): string | null {
  let candidate = rawWebsite.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  if (IPV4_RE.test(host) || host.includes(':')) return null; // IPv4 or IPv6 literal

  const labels = host.split('.');
  if (labels.length < 2) return null; // bare single-label host, e.g. "acme" or "localhost"

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) || NON_PUBLIC_TLDS.has(tld)) return null;

  return host;
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
    // row with no owning member — best-effort, not atomic with the two
    // inserts above. The delete's own result IS checked (2026-11-05 review
    // finding: an earlier version of this code discarded it entirely while
    // claiming otherwise in this comment) — if the rollback itself fails,
    // that is logged with both errors and the company's domain/id, since the
    // caller only ever sees `memberError` and would otherwise have no way to
    // know the orphaned row is still there.
    const { error: rollbackError } = await admin.from('companies').delete().eq('id', company.id);
    if (rollbackError) {
      console.error(
        '[employer/register] rollback delete failed after company_members insert failed — orphaned company row remains',
        { companyId: company.id, officialDomain, memberError: memberError.message, rollbackError: rollbackError.message }
      );
    }
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  return NextResponse.json(
    { companyId: company.id, verificationStatus: company.verification_status },
    { status: 201 }
  );
}
