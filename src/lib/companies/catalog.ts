/**
 * RemoteMatch — Company Radar Phase 0: read-only company reads.
 * ==============================================================================
 * Deliberately a SEPARATE module from src/lib/ingestion/catalog-read.ts rather
 * than an addition to it: test/egress-trim-suite.ts pins catalog-read.ts's own
 * shared full-column-list constant as used only inside that one file (a plain
 * repo-wide text scan — this file must never spell that constant's exact
 * identifier, even in a comment, or it trips that scan), and the approved
 * Phase 0 baseline is "no catalog-read.ts changes" (docs/company-radar-phase0-
 * implementation-plan-2026-10-24.md §2.1). So this file defines its own,
 * narrower column list instead of importing the shared one — a deliberate
 * small duplication, not an oversight.
 *
 * Company identity is EXACT STRING MATCH ONLY (`.eq('company', ...)`), never
 * fuzzy, normalized, or alias-resolved — per the approved decision gate. Two
 * raw `company` values that are really the same employer (e.g. "GitLab" vs.
 * "gitlab") resolve to two separate profiles in Phase 0. That is an accepted,
 * documented limitation, not a bug to work around here.
 *
 * RLS (`opportunities_select_active`, migration 002) is the only access
 * control. Every function below takes the caller's Supabase client as a
 * parameter and is called, in production, with the anon public client
 * (src/lib/supabase/server.ts's createSupabasePublicClient()) — the same
 * client and the same trust boundary the existing /remote-jobs directory
 * already uses. No admin/service-role client is referenced anywhere in this
 * file.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const COMPANY_READ_COLUMNS =
  'company, company_logo, title, source, source_url, official_url, remote_type, ' +
  'eligible_countries, excluded_countries, required_skills, status, posted_at';

interface CompanyOpportunityRow {
  company: string;
  company_logo: string | null;
  title: string;
  source: string;
  source_url: string | null;
  official_url: string;
  remote_type: string;
  eligible_countries: string[] | null;
  excluded_countries: string[] | null;
  required_skills: string[] | null;
  status: string;
  posted_at: string;
}

export interface CompanyOpportunity {
  company: string;
  companyLogo?: string;
  title: string;
  source: string;
  sourceUrl?: string;
  officialUrl: string;
  remoteType: string;
  eligibleCountries: string[];
  excludedCountries: string[];
  requiredSkills: string[];
  postedAt: string;
}

function mapRow(row: CompanyOpportunityRow): CompanyOpportunity {
  return {
    company: row.company,
    companyLogo: row.company_logo ?? undefined,
    title: row.title,
    source: row.source,
    sourceUrl: row.source_url ?? undefined,
    officialUrl: row.official_url,
    remoteType: row.remote_type,
    eligibleCountries: row.eligible_countries ?? [],
    excludedCountries: row.excluded_countries ?? [],
    requiredSkills: row.required_skills ?? [],
    postedAt: row.posted_at,
  };
}

/**
 * What each source's application link actually is — confirmed per provider
 * in docs/company-radar-phase0-readiness-report-2026-10-24.md §Blocker 3.
 * `official_url` is the ATS's own hosted page for greenhouse/lever/ashby,
 * that aggregator's own listing page for the others, and the employer's own
 * domain only for `curated` (hand-authored fixtures) and `careerpage` (the
 * C5 company-career-page extraction channel, which fetches the employer's
 * own domain by construction — see src/lib/providers/career-page.ts). Never
 * labeled "Company website" for any of the others.
 */
const SOURCE_LABELS: Record<string, string> = {
  greenhouse: 'Apply via Greenhouse',
  lever: 'Apply via Lever',
  ashby: 'Apply via Ashby',
  himalayas: 'View on Himalayas',
  weworkremotely: 'View on We Work Remotely',
  remoteok: 'View on RemoteOK',
  remotive: 'View on Remotive',
  arbeitnow: 'View on Arbeitnow',
  jobicy: 'View on Jobicy',
  careerpage: 'Apply directly',
  curated: 'Apply directly',
};

/** Human label for a source slug's application link. Any source not in the
 *  table above (future provider) gets a neutral, non-committal label rather
 *  than a guessed one. */
export function labelForSource(source: string): string {
  return SOURCE_LABELS[source] ?? 'View listing';
}

const MAX_COMPANY_NAME_LENGTH = 200;

/** Defensive shape guard for a company name decoded from a URL segment —
 *  mirrors getActiveOpportunityByCanonicalId's guard in catalog-read.ts. */
export function isValidCompanyName(name: string): boolean {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_COMPANY_NAME_LENGTH;
}

const MAX_SEARCH_TERM_LENGTH = 80;

/**
 * Free text -> a safe company-search term, or null if nothing usable
 * remains. Allows the punctuation real company names use ('.', "'", '&',
 * ',') that buildSearchTerms (job-search terms, skill-tag shaped) does not.
 * Passed to the client's `.ilike()` method (not string-interpolated into an
 * `.or()` filter, unlike searchActiveOpportunitiesPage), so this is a defensive
 * length/charset cap, not an injection guard — supabase-js parameterizes a
 * plain `.ilike()` call itself.
 *
 * Known, accepted Phase 0 imprecision: a literal `%` or `_` in the input is
 * not escaped, so it is matched as a SQL LIKE wildcard rather than a literal
 * character. Cosmetic (occasionally over-broad results), not a correctness
 * or security issue.
 */
export function sanitizeCompanySearchTerm(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // Denylist rather than an allowlist-via-unicode-property-escape (the `u`
  // regex flag needs a newer `target` than this project's tsconfig uses) —
  // strips characters that could be read as markup/code or PostgREST filter
  // syntax while leaving real company names (including non-Latin names and
  // '.', "'", '&', ',') untouched.
  const t = raw
    .trim()
    .slice(0, MAX_SEARCH_TERM_LENGTH)
    .replace(/[<>{}\\`|;]/g, '')
    .replace(/\s+/g, ' ');
  const trimmed = t.trim();
  return trimmed || null;
}

export interface CompanyPage {
  rows: CompanyOpportunity[];
  total: number;
}

/**
 * Every currently active opportunity for an EXACT company string. Bounded to
 * `range` (defaults to a generous single page — one employer's listings are
 * never catalog-sized). RLS-scoped like every other public read in this
 * codebase: `status = 'active'` is enforced by `opportunities_select_active`
 * regardless of the explicit `.eq('status', 'active')` below, which is
 * defense-in-depth, matching this codebase's existing style of never relying
 * on RLS alone (see e.g. feed/route.ts's loadEffectiveDecisions).
 */
export async function getOpportunitiesByExactCompany(
  supabase: SupabaseClient,
  companyName: string,
  range: { from: number; to: number } = { from: 0, to: 99 }
): Promise<CompanyPage> {
  if (!isValidCompanyName(companyName)) return { rows: [], total: 0 };
  const { data, count, error } = await supabase
    .from('opportunities')
    .select(COMPANY_READ_COLUMNS, { count: 'exact' })
    .eq('status', 'active')
    .eq('company', companyName)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .range(range.from, range.to);
  if (error) throw new Error(`Could not read opportunities for company: ${error.message}`);
  return { rows: ((data ?? []) as unknown as CompanyOpportunityRow[]).map(mapRow), total: count ?? 0 };
}

/**
 * One page of active opportunities whose `company` matches the sanitized
 * term (case-insensitive substring), deduplicated to one row per distinct
 * raw company string WITHIN the page. `total` counts matching opportunity
 * rows, not distinct companies — PostgREST has no GROUP BY, and Phase 0
 * deliberately does not add one (no view, no migration). A page can
 * therefore show fewer than `range`'s width in distinct companies when one
 * employer has several active listings. Accepted Phase 0 limitation.
 *
 * Deliberately its own `.ilike('company', ...)` query rather than reusing
 * searchActiveOpportunitiesPage() (catalog-read.ts), which also matches
 * title/description/remote_type/skill tags — appropriate for job search, too
 * imprecise for a dedicated company search box (e.g. "Cloud" would surface
 * jobs whose *title* mentions "Cloud" at an unrelated company).
 */
export async function searchCompanies(
  supabase: SupabaseClient,
  term: string,
  range: { from: number; to: number }
): Promise<CompanyPage> {
  const safe = sanitizeCompanySearchTerm(term);
  if (!safe) return { rows: [], total: 0 };
  const { data, count, error } = await supabase
    .from('opportunities')
    .select(COMPANY_READ_COLUMNS, { count: 'exact' })
    .eq('status', 'active')
    .ilike('company', `%${safe}%`)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .range(range.from, range.to);
  if (error) throw new Error(`Could not search companies: ${error.message}`);
  const seen = new Set<string>();
  const rows: CompanyOpportunity[] = [];
  for (const row of (data ?? []) as unknown as CompanyOpportunityRow[]) {
    if (seen.has(row.company)) continue;
    seen.add(row.company);
    rows.push(mapRow(row));
  }
  return { rows, total: count ?? 0 };
}
