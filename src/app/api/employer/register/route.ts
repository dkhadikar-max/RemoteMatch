import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { normalizeDomain } from '@/lib/employer/normalize-domain';
import { EMPLOYER_INDUSTRIES, EMPLOYER_COMPANY_SIZES } from '@/lib/employer/taxonomy';

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
    isOptionalString(b.industry, MAX_TEXT) && (b.industry === undefined || (EMPLOYER_INDUSTRIES as readonly string[]).includes(String(b.industry))) &&
    isOptionalString(b.companySize, MAX_TEXT) && (b.companySize === undefined || (EMPLOYER_COMPANY_SIZES as readonly string[]).includes(String(b.companySize))) &&
    isOptionalString(b.description, MAX_LONG_TEXT) &&
    isOptionalString(b.headquarters, MAX_TEXT)
  );
}

/**
 * POST /api/employer/register — Direct Employer Supply, Phase 1. Creates a
 * `companies` row (`verification_status = 'pending'`) and the registering
 * caller's own `company_members` row (`role = 'owner'`) carrying the
 * authorized-representative fields from the PRD, ATOMICALLY via the
 * `register_employer_company()` RPC (migration 045) — a 2026-11-06 review
 * finding fix: an earlier version did two separate inserts with a
 * best-effort compensating delete, which left a real gap (a process crash
 * between the two inserts orphaned the companies row forever, with no
 * recovery). The RPC is one Postgres transaction: either both rows exist
 * or neither does.
 *
 * No business-email verification (Phase 1 plan Q2 — deferred); no fuzzy
 * duplicate detection (Q3 — the official_domain unique index is the whole
 * mechanism here).
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

  const { data: rpcRows, error: rpcError } = await admin.rpc('register_employer_company', {
    p_legal_name: body.legalName.trim(),
    p_official_website: body.officialWebsite.trim(),
    p_official_domain: officialDomain,
    p_business_email: body.businessEmail.trim(),
    p_country_of_registration: body.countryOfRegistration.trim(),
    p_registration_number: body.registrationNumber?.trim() || null,
    p_linkedin_url: body.linkedinUrl?.trim() || null,
    p_industry: body.industry?.trim() || null,
    p_company_size: body.companySize?.trim() || null,
    p_description: body.description?.trim() || null,
    p_headquarters: body.headquarters?.trim() || null,
    p_created_by: user.id,
    p_representative_name: body.representativeName.trim(),
    p_representative_designation: body.representativeDesignation.trim(),
    p_representative_relationship: body.representativeRelationship.trim(),
  });

  if (rpcError) {
    // Unique violation on official_domain. Rather than a bare 409, check
    // whether THIS caller already owns the existing company at this domain
    // (2026-11-06 review finding fix: a lost HTTP response after a fully
    // successful registration previously left the caller stuck behind a
    // 409 with no way back to the company they just created) — if so,
    // hand back that company instead of an error, so a retry recovers
    // instead of dead-ending. A domain already owned by someone ELSE still
    // gets the plain conflict, with no information about who owns it.
    if (rpcError.code === '23505') {
      // Both lookups' own errors are checked (2026-11-06 review, found
      // during this same pass's re-verification): a transient DB error on
      // EITHER lookup must not silently fall through to the generic 409 —
      // that would wrongly tell a caller "this domain is taken" when a
      // read failure, not a real ownership mismatch, is why recovery
      // couldn't be confirmed. Logged and reported as a real 500 instead.
      const { data: existing, error: existingErr } = await admin
        .from('companies')
        .select('id, verification_status')
        .eq('official_domain', officialDomain)
        .maybeSingle();
      if (existingErr) {
        console.error('[employer/register] lookup for retry-recovery failed after a 23505 on companies', {
          officialDomain, error: existingErr.message,
        });
        return NextResponse.json({ error: 'Could not verify registration status for this domain.' }, { status: 500 });
      }
      if (existing) {
        const { data: existingMembership, error: membershipErr } = await admin
          .from('company_members')
          .select('id')
          .eq('company_id', existing.id)
          .eq('profile_id', user.id)
          .eq('status', 'active')
          .maybeSingle();
        if (membershipErr) {
          console.error('[employer/register] lookup for retry-recovery failed after a 23505 on company_members', {
            companyId: existing.id, error: membershipErr.message,
          });
          return NextResponse.json({ error: 'Could not verify registration status for this domain.' }, { status: 500 });
        }
        if (existingMembership) {
          return NextResponse.json(
            { companyId: existing.id, verificationStatus: existing.verification_status, alreadyRegistered: true },
            { status: 200 }
          );
        }
      }
      return NextResponse.json(
        { error: 'A company is already registered for this website domain.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const company = (rpcRows ?? [])[0] as { id: string; verification_status: string } | undefined;
  if (!company) {
    // Should be unreachable — the RPC either returns exactly one row or
    // throws. Fails loudly rather than crashing on `company.id` below.
    return NextResponse.json({ error: 'Registration did not return a company record.' }, { status: 500 });
  }

  return NextResponse.json(
    { companyId: company.id, verificationStatus: company.verification_status },
    { status: 201 }
  );
}
