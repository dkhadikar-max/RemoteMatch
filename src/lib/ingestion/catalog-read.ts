/**
 * RemoteMatch — Live Supply Activation: shared read-side mapping
 * ==============================================================================
 * Maps a persisted `opportunities` row back to the CanonicalOpportunity
 * shape that matching/scoring, the swipe route, and the SEO layer already
 * expect — none of that logic changes; it just receives its input from the
 * database now instead of the in-memory CURATED_JOBS array.
 *
 * IMPORTANT: CanonicalOpportunity.id is the `opp-${source}-${sourceId}`
 * STRING already used throughout swipes/applications (opportunity_id is
 * TEXT there, per 003_security_remediation.sql) — never the opportunities
 * table's own UUID primary key. Getting this wrong would silently break
 * every existing swipe/application/decision-snapshot join.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { CanonicalOpportunity } from '@/types/byn';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

const OPPORTUNITY_COLUMNS =
  'id, type, title, company, company_logo, description, source, source_id, source_url, ' +
  'official_url, canonical_url_hash, content_hash, employment_type, remote_type, ' +
  'eligible_countries, excluded_countries, timezone_requirements, salary_min, salary_max, ' +
  'salary_currency, salary_period, required_skills, preferred_skills, experience_requirement, quality_score, ' +
  'source_quality, description_completeness, salary_quality, remote_policy_confidence, ' +
  'explicit_remote_scope, status, posted_at, is_permanently_removed, link_checked_at, ' +
  'superseded_by_opportunity_id';

interface OpportunityRow {
  id: string;
  type: string;
  title: string;
  company: string;
  company_logo: string | null;
  description: string;
  // Acquisition platform slug (supply_platforms.slug). Dynamic set since gate
  // C1 — was a closed union.
  source: string;
  source_id: string;
  source_url: string | null;
  official_url: string;
  canonical_url_hash: string;
  content_hash: string;
  employment_type: string;
  remote_type: string;
  eligible_countries: string[];
  excluded_countries: string[];
  timezone_requirements: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: string | null;
  required_skills: string[];
  preferred_skills: string[];
  experience_requirement: string | null;
  quality_score: number;
  source_quality: number | null;
  description_completeness: string | null;
  salary_quality: string | null;
  remote_policy_confidence: string | null;
  explicit_remote_scope: string | null;
  status: string;
  posted_at: string;
  is_permanently_removed: boolean;
  link_checked_at: string | null;
  // M-adjacent-1 (migration 018) — nullable. WARNING: this column is now
  // part of OPPORTUNITY_COLUMNS below, so every call to getActiveOpportunities
  // / getActiveOpportunityByCanonicalId / getOpportunityBySourceIdAnyStatus
  // requires migration 018 to be live — against a pre-018 database the
  // SELECT itself fails (unknown column), not just this field. Do not run
  // any real-infra test that touches the opportunities catalog read path
  // until the migration is confirmed applied.
  superseded_by_opportunity_id: string | null;
}

export function rowToCanonicalOpportunity(row: OpportunityRow): CanonicalOpportunity {
  return {
    id: `opp-${row.source}-${row.source_id}`,
    type: row.type as CanonicalOpportunity['type'],
    title: row.title,
    company: row.company,
    companyLogo: row.company_logo ?? undefined,
    description: row.description,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url ?? undefined,
    officialUrl: row.official_url,
    canonicalUrlHash: row.canonical_url_hash,
    contentHash: row.content_hash,
    employmentType: row.employment_type as CanonicalOpportunity['employmentType'],
    remoteType: row.remote_type as CanonicalOpportunity['remoteType'],
    eligibleCountries: row.eligible_countries ?? [],
    excludedCountries: row.excluded_countries ?? [],
    timezoneRequirements: row.timezone_requirements ?? [],
    salaryMin: row.salary_min ?? undefined,
    salaryMax: row.salary_max ?? undefined,
    salaryCurrency: row.salary_currency,
    salaryPeriod: (row.salary_period as CanonicalOpportunity['salaryPeriod']) ?? undefined,
    requiredSkills: row.required_skills ?? [],
    preferredSkills: row.preferred_skills ?? [],
    experienceRequirement: row.experience_requirement ?? undefined,
    qualityScore: row.quality_score,
    sourceQuality: row.source_quality ?? undefined,
    descriptionCompleteness: row.description_completeness as CanonicalOpportunity['descriptionCompleteness'],
    salaryQuality: row.salary_quality as CanonicalOpportunity['salaryQuality'],
    remotePolicyConfidence: row.remote_policy_confidence as CanonicalOpportunity['remotePolicyConfidence'],
    explicitRemoteScope: row.explicit_remote_scope as CanonicalOpportunity['explicitRemoteScope'],
    status: row.status as CanonicalOpportunity['status'],
    isActive: row.status === 'active',
    isPermanentlyRemoved: row.is_permanently_removed,
    linkCheckedAt: row.link_checked_at ?? undefined,
    supersededByOpportunityId: row.superseded_by_opportunity_id ?? null,
    postedAt: row.posted_at,
    lastVerifiedAt: row.posted_at, // see deprecation note on the column itself; not used as freshness evidence
  };
}

/** Every publicly-visible opportunity — relies entirely on RLS
 *  (`opportunities_select_active`, USING (status = 'active')) to exclude
 *  unknown/expired/draft rows, via whichever client (anon or an
 *  authenticated user's own session) is passed in. Never uses the admin
 *  client for a product/SEO-facing read — that would bypass the exact
 *  guarantee this whole design depends on. */
export async function getActiveOpportunities(supabase: SupabaseClient): Promise<CanonicalOpportunity[]> {
  const { data, error } = await supabase.from('opportunities').select(OPPORTUNITY_COLUMNS);
  if (error) throw new Error(`Could not read active opportunities: ${error.message}`);
  return (data ?? []).map((row) => rowToCanonicalOpportunity(row as unknown as OpportunityRow));
}

/** Looks up a single opportunity by its `opp-${source}-${sourceId}` id
 *  string (the format used everywhere else in the app — swipes,
 *  applications, decision snapshots). RLS-scoped like the function above:
 *  only returns a result if the row is currently 'active'.
 *
 *  Gate C1: matches the persisted, generated `canonical_id` column directly
 *  (`'opp-' || source || '-' || source_id`, migration 012) instead of
 *  parsing the string with `/^opp-([a-z]+)-(.+)$/` — that regex could not
 *  survive a source slug outside `[a-z]` (the discovery registry adds slugs
 *  like `greenhouse`) or a hyphenated `source_id`. A shape guard still
 *  rejects obvious non-ids before a query. */
export async function getActiveOpportunityByCanonicalId(
  supabase: SupabaseClient,
  canonicalId: string
): Promise<CanonicalOpportunity | null> {
  if (typeof canonicalId !== 'string' || !canonicalId.startsWith('opp-') || canonicalId.length > 200) {
    return null;
  }

  const { data, error } = await supabase
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS)
    .eq('canonical_id', canonicalId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToCanonicalOpportunity(data as unknown as OpportunityRow);
}

/**
 * Looks up a job by its bare `source_id` (the format the public
 * `/remote-jobs/view/[id]` URL and middleware's 410 check have always
 * used — pre-existing convention, unchanged) REGARDLESS of status.
 *
 * Deliberately uses the admin client, not RLS: `opportunities_select_active`
 * walls off non-'active' rows from every public role, including a
 * single-row lookup by id — but the entire point of this function is to
 * decide HOW to respond to an expired/removed job (410 vs. noindex vs.
 * normal), which requires being able to see that it's expired in the first
 * place. This is a deliberate, narrow, read-only exception to "never use
 * the admin client for a product/SEO-facing read" — the alternative would
 * make the existing 410/noindex feature impossible to implement at all.
 *
 * `source_id` alone is not guaranteed globally unique across all four
 * providers (curated's are prefixed "curated-NNN" by convention and always
 * have been; live providers' raw ids are not namespaced) — same implicit
 * assumption the original CURATED_JOBS-only lookup already made. First
 * match wins, matching the original `.find()` semantics exactly.
 */
export async function getOpportunityBySourceIdAnyStatus(sourceId: string): Promise<CanonicalOpportunity | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS)
    .eq('source_id', sourceId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return rowToCanonicalOpportunity(data as unknown as OpportunityRow);
}
