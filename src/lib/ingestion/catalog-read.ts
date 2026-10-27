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
import { getFreshnessWindowBounds } from './freshness-gate';

/**
 * Exactly the columns rowToCanonicalOpportunity() reads — nothing more. Every
 * byte selected here is paid for in Supabase egress on every catalog read
 * (~70 MB uncompressed at ~23k rows), so a column the mapper never touches
 * must not be in this list. test/egress-trim-suite.ts pins the two together
 * (column list == the `row.<field>` set the mapper reads), so adding a field
 * to the mapper without selecting it — or selecting one it ignores — fails.
 *
 * Deliberately NOT selected, because the mapper ignores them:
 *   - `id` (the CanonicalOpportunity id is derived `opp-${source}-${source_id}`,
 *     never the table's UUID — see the file header);
 *   - the translation bookkeeping columns (migration 028: source_language,
 *     original_title, original_description, translated_at, translation_model,
 *     translated_content_hash, translation_status). They are written and read
 *     by the translation pass (translate-pending.ts, with its own SELECTs) and
 *     FILTERED on server-side via `translationSafe` below — a filter needs no
 *     SELECT. original_description alone carries a full second copy of the
 *     description for every translated row.
 */
export const OPPORTUNITY_COLUMNS =
  'type, title, company, company_logo, description, source, source_id, source_url, ' +
  'official_url, canonical_url_hash, content_hash, employment_type, remote_type, ' +
  'eligible_countries, excluded_countries, timezone_requirements, salary_min, salary_max, ' +
  'salary_currency, salary_period, required_skills, preferred_skills, experience_requirement, quality_score, ' +
  'source_quality, description_completeness, salary_quality, remote_policy_confidence, ' +
  'explicit_remote_scope, status, posted_at, is_permanently_removed, link_checked_at, ' +
  'superseded_by_opportunity_id';

/** The four columns the sitemap actually needs (URL id, category matching on
 *  title/skills, lastModified from posted_at). No description, no company, no
 *  URLs — see getSitemapJobEntries(). */
export const SITEMAP_COLUMNS = 'source_id, title, posted_at, required_skills';

/**
 * THE multilingual gate (migration 028), shared by every user-facing and SEO read.
 * A listing is visible only if BOTH hold:
 *   1. TRANSLATION_SAFE_OR — source_language is NULL (pass not run yet), 'en', or
 *      translation_status = 'ok' (a non-English row that was successfully translated);
 *   2. TRANSLATION_NOT_ERROR_OR — translation_status is NOT 'error'.
 * (2) closes a hole in (1): a row whose translation FAILED without a known language
 * keeps source_language NULL, which (1) alone lets through — an untranslated foreign
 * listing visible forever. `translation_status.neq.error` alone would drop NULL-status
 * rows (SQL three-valued logic), hence the explicit `is.null` branch.
 * The translation pass leaves rows PENDING (status NULL, still visible) on a
 * batch-level failure such as a quota error, so this rule only ever hides rows that
 * failed individually and definitively.
 */
export const TRANSLATION_SAFE_OR = 'source_language.is.null,source_language.eq.en,translation_status.eq.ok';
export const TRANSLATION_NOT_ERROR_OR = 'translation_status.is.null,translation_status.neq.error';

/** Applies the multilingual gate to a PostgREST query (two ANDed .or() filters). */
export function applyTranslationSafe<Q extends { or(filters: string): Q }>(query: Q): Q {
  return query.or(TRANSLATION_SAFE_OR).or(TRANSLATION_NOT_ERROR_OR);
}

interface OpportunityRow {
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
 *  guarantee this whole design depends on.
 *
 *  `options.freshOnly` (Supply Discovery gate C3-B): the read-time half of
 *  the 48-hour freshness invariant, applied GLOBALLY across every source
 *  when set — not just the 3 new ATS ones (that scope decision was made
 *  explicitly; C3-A's ingestion-time gate was ATS-only, this one is not).
 *  Computed fresh on every call (getFreshnessWindowBounds() reads the
 *  current time each time), so a row that WAS fresh when ingested
 *  correctly stops qualifying once it ages past 48h on its very next read
 *  — no background job, no status mutation, no extra column. Deliberately
 *  opt-in rather than baked into every caller: the SEO/sitemap/public-
 *  directory surface (src/lib/seo/data.ts) and the resume-driven skill-gap
 *  statistics (api/resume/opportunities) serve a different purpose —
 *  comprehensive catalog indexing and durable skill-gap signal,
 *  respectively — where excluding anything older than 48h would be wrong,
 *  not a freshness improvement. Applied explicitly at the one call site
 *  that IS "the feed": src/app/api/opportunities/feed/route.ts.
 *
 *  `options.translationSafe` (Multilingual gate, migration 028):
 *  Fail-closed filter — excludes non-English rows that have not yet been
 *  successfully translated. When true, only rows matching ANY of the
 *  following are returned:
 *    (a) source_language IS NULL   — pass not yet run (briefly invisible)
 *    (b) source_language = 'en'    — English, no translation needed
 *    (c) translation_status = 'ok' — non-English, successfully translated
 *  AND, in every case, translation_status is not 'error' (see
 *  TRANSLATION_NOT_ERROR_OR above: a row whose translation failed is hidden even
 *  when no source language was ever detected for it).
 *  This MUST be set for every user-facing feed path and every SEO/sitemap
 *  path (Decision 4). A row with translation_status = 'error' is NEVER shown to
 *  users or indexed. */
export async function getActiveOpportunities(
  supabase: SupabaseClient,
  options?: { freshOnly?: boolean; translationSafe?: boolean }
): Promise<CanonicalOpportunity[]> {
  const allRows: OpportunityRow[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    let query = supabase.from('opportunities').select(OPPORTUNITY_COLUMNS);
    if (options?.freshOnly) {
      const { from: windowFrom, to: windowTo } = getFreshnessWindowBounds();
      query = query.gte('posted_at', windowFrom).lte('posted_at', windowTo);
    }
    if (options?.translationSafe) {
      query = applyTranslationSafe(query);
    }
    query = query.range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read active opportunities: ${error.message}`);
    if (!data || data.length === 0) break;
    allRows.push(...(data as unknown as OpportunityRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows.map(rowToCanonicalOpportunity);
}

/** A few OTHER active listings, for the "related jobs" cards on a job page.
 *
 *  Exists because those cards used to call getActiveOpportunities() — a read
 *  of the WHOLE catalog (~21 MB over the wire at ~23k rows) on every job-page
 *  view — only to keep `.slice(0, 3)` of it. This asks the database for just
 *  `limit` rows (default 3), so a page view now transfers a few KB.
 *
 *  Same visibility rules as the full read: RLS limits an anon/public client
 *  to status = 'active', and the multilingual gate (translationSafe) is
 *  applied so an untranslated non-English listing is never surfaced.
 *  Deliberately unordered, like the read it replaces: an ORDER BY would make
 *  the database sort the whole active set to pick 3 rows. */
export async function getRelatedActiveOpportunities(
  supabase: SupabaseClient,
  excludeSourceId: string,
  limit = 3
): Promise<CanonicalOpportunity[]> {
  const n = Math.min(Math.max(Math.floor(limit), 1), 20);
  const { data, error } = await supabase
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS)
    .or(TRANSLATION_SAFE_OR)
    .or(TRANSLATION_NOT_ERROR_OR)
    .neq('source_id', excludeSourceId)
    .limit(n);
  if (error) throw new Error(`Could not read related opportunities: ${error.message}`);
  return ((data ?? []) as unknown as OpportunityRow[]).map(rowToCanonicalOpportunity);
}



/** What the sitemap needs from one active listing — see SITEMAP_COLUMNS. */
export interface SitemapJobEntry {
  sourceId: string;
  title: string;
  postedAt: string;
  requiredSkills: string[];
}

/** Every active, translation-safe listing, reduced to the four fields the
 *  sitemap uses. Replaces getActiveJobs() (the whole catalog, descriptions
 *  and all) for sitemap.xml — same visibility rules, a fraction of the bytes.
 *
 *  Same gates as getActiveJobs(): RLS limits an anon/public client to
 *  status = 'active', and the multilingual gate (translationSafe) is applied
 *  so an untranslated non-English listing is never indexed.
 *
 *  Unlike the full read, this pages over a DETERMINISTIC order
 *  (source, source_id — the table's natural key). `.range()` without an
 *  ORDER BY gives no guarantee that pages don't overlap or skip rows while the
 *  catalog is being written to, which for a sitemap means missing or repeated
 *  URLs; the sort is on ~23k narrow keys, cheap next to the bytes it saves. */
export async function getSitemapJobEntries(supabase: SupabaseClient): Promise<SitemapJobEntry[]> {
  const entries: SitemapJobEntry[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('opportunities')
      .select(SITEMAP_COLUMNS)
      .or(TRANSLATION_SAFE_OR)
      .or(TRANSLATION_NOT_ERROR_OR)
      .order('source', { ascending: true })
      .order('source_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not read sitemap job entries: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as unknown as Array<{
      source_id: string;
      title: string;
      posted_at: string;
      required_skills: string[] | null;
    }>) {
      entries.push({
        sourceId: row.source_id,
        title: row.title,
        postedAt: row.posted_at,
        requiredSkills: row.required_skills ?? [],
      });
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return entries;
}

/** The columns the directory/category hubs need to decide MEMBERSHIP and
 *  ORDER without loading a single description — see getCatalogIndexEntries(). */
export const CATALOG_INDEX_COLUMNS =
  'source_id, title, posted_at, required_skills, remote_type, eligible_countries, experience_requirement';

/** One active listing reduced to what category membership + ordering need. */
export interface CatalogIndexEntry {
  sourceId: string;
  title: string;
  /** ISO timestamp, or '' when the row has none (sorted last). */
  postedAt: string;
  requiredSkills: string[];
  remoteType: string;
  eligibleCountries: string[];
  experienceRequirement?: string;
}

/**
 * The slim catalog index behind the paginated directory and category hubs:
 * every active, translation-safe listing's membership fields (~7 narrow
 * columns, no description/company/URLs), newest first. Callers keep it behind
 * a long TTL cache (src/lib/seo/directory.ts) so a page view costs a 24-row
 * slice fetch, not a catalog read.
 *
 * Same visibility rules as getActiveJobs(): RLS (active only) via whichever
 * client is passed, plus the multilingual translationSafe gate. Pages over a
 * deterministic (source, source_id) order — see getSitemapJobEntries().
 */
export async function getCatalogIndexEntries(supabase: SupabaseClient): Promise<CatalogIndexEntry[]> {
  const entries: CatalogIndexEntry[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('opportunities')
      .select(CATALOG_INDEX_COLUMNS)
      .or(TRANSLATION_SAFE_OR)
      .or(TRANSLATION_NOT_ERROR_OR)
      .order('source', { ascending: true })
      .order('source_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not read the catalog index: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as unknown as Array<{
      source_id: string;
      title: string;
      posted_at: string | null;
      required_skills: string[] | null;
      remote_type: string | null;
      eligible_countries: string[] | null;
      experience_requirement: string | null;
    }>) {
      entries.push({
        sourceId: row.source_id,
        title: row.title,
        postedAt: row.posted_at ?? '',
        requiredSkills: row.required_skills ?? [],
        remoteType: row.remote_type ?? '',
        eligibleCountries: row.eligible_countries ?? [],
        experienceRequirement: row.experience_requirement ?? undefined,
      });
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  // Newest first; '' (no date) last; sourceId breaks ties so the order is total.
  entries.sort((a, b) => (a.postedAt === b.postedAt ? (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) : a.postedAt < b.postedAt ? 1 : -1));
  return entries;
}

/**
 * Full CanonicalOpportunity rows for a short list of source ids (one page of a
 * hub — tens of rows), returned in the order of `sourceIds`. Same gates as the
 * full read (RLS active-only + translationSafe). Ids that no longer resolve
 * (expired since the index was built) are simply absent; a source_id shared by
 * two sources resolves to the first row seen, matching the "first match wins"
 * convention the job page already uses.
 */
export async function getOpportunitiesBySourceIds(supabase: SupabaseClient, sourceIds: string[]): Promise<CanonicalOpportunity[]> {
  const ids = Array.from(new Set(sourceIds)).slice(0, 100);
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS)
    .in('source_id', ids)
    .or(TRANSLATION_SAFE_OR)
    .or(TRANSLATION_NOT_ERROR_OR);
  if (error) throw new Error(`Could not read opportunities by source id: ${error.message}`);
  const bySourceId = new Map<string, CanonicalOpportunity>();
  for (const row of (data ?? []) as unknown as OpportunityRow[]) {
    if (!bySourceId.has(row.source_id)) bySourceId.set(row.source_id, rowToCanonicalOpportunity(row));
  }
  const out: CanonicalOpportunity[] = [];
  for (const id of ids) {
    const o = bySourceId.get(id);
    if (o) out.push(o);
  }
  return out;
}

/**
 * One page of active, translation-safe listings matching every term, answered
 * by the database (ILIKE on title / company / description / remote type, plus
 * the term as a whole skill tag in its common casings), newest first, with an
 * exact total for pagination. Terms MUST already be sanitised
 * (buildSearchTerms() in src/lib/seo/directory.ts) — they are embedded in a
 * PostgREST filter and an ILIKE pattern.
 *
 * Never loads the catalog: cost is one page of rows however large it grows.
 */
export class SearchTimeoutError extends Error {
  constructor() {
    super('Search took too long and was canceled by the database.');
    this.name = 'SearchTimeoutError';
  }
}

/** Postgres SQLSTATE 57014 = query_canceled (statement_timeout). Checked by code first, same
 *  convention as isMissingRelation() in src/lib/supabase/query-helpers.ts; the message-text
 *  fallback is defensive only, in case a future PostgREST/Postgres version omits code. */
function isStatementTimeout(error: { code?: string | null; message?: string } | null | undefined): boolean {
  return !!error && (error.code === '57014' || /statement timeout/i.test(error.message ?? ''));
}

export async function searchActiveOpportunitiesPage(
  supabase: SupabaseClient,
  terms: string[],
  range: { from: number; to: number }
): Promise<{ rows: CanonicalOpportunity[]; total: number }> {
  let query = supabase
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS, { count: 'exact' })
    .or(TRANSLATION_SAFE_OR)
    .or(TRANSLATION_NOT_ERROR_OR);
  for (const t of terms) {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    const skillVariants = Array.from(new Set([t, cap, t.toUpperCase()]));
    const clauses = [
      `title.ilike.*${t}*`,
      `company.ilike.*${t}*`,
      `description.ilike.*${t}*`,
      `remote_type.ilike.*${t}*`,
      ...skillVariants.map((v) => `required_skills.cs.{${v}}`),
    ];
    // Several .or() calls are ANDed by PostgREST: every term must match somewhere.
    query = query.or(clauses.join(','));
  }
  const { data, count, error } = await query
    .order('posted_at', { ascending: false, nullsFirst: false })
    .order('source_id', { ascending: true })
    .range(range.from, range.to);
  if (error) {
    if (isStatementTimeout(error)) throw new SearchTimeoutError();
    throw new Error(`Could not search opportunities: ${error.message}`);
  }
  return { rows: ((data ?? []) as unknown as OpportunityRow[]).map(rowToCanonicalOpportunity), total: count ?? 0 };
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

/**
 * Batch lookup by canonical id (`opp-${source}-${sourceId}`), REGARDLESS of
 * status — Tracker Opportunity Resolution's read path.
 *
 * Deliberately uses the admin client, not RLS, for the same reason as
 * `getOpportunityBySourceIdAnyStatus` above: `opportunities_select_active`
 * walls off non-'active' rows from every role, but a user's Tracker page
 * must still show the real title/company for an application against a job
 * that has since expired — the application represents what they actually
 * acted on, and its lifecycle is independent of the opportunity's.
 *
 * The trust anchor is NOT this function — it is the caller's responsibility
 * to have already proven, via the caller's own RLS-scoped `applications`
 * query, that every id passed in belongs to that authenticated user's own
 * applications. This function does no ownership check itself and must never
 * be called with a client-supplied id list (see
 * `/api/applications/opportunities`, its only caller).
 *
 * A superseded opportunity resolves to its OWN row here — this function has
 * no knowledge of `superseded_by_opportunity_id` and never follows it;
 * that's what keeps a Tracker entry pointing at what the user actually
 * applied to, not silently redirecting to a reconciliation survivor.
 *
 * Matches `.in('canonical_id', ...)` against the same persisted, generated
 * column `getActiveOpportunityByCanonicalId` uses above, for the same
 * reason: parsing the `opp-${source}-${sourceId}` string back apart cannot
 * survive a hyphenated source slug or source id.
 */
export async function getOpportunitiesByCanonicalIdsAnyStatus(
  canonicalIds: string[]
): Promise<CanonicalOpportunity[]> {
  const validIds = canonicalIds.filter(
    (id) => typeof id === 'string' && id.startsWith('opp-') && id.length <= 200
  );
  if (validIds.length === 0) return [];

  const admin = getSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from('opportunities')
    .select(OPPORTUNITY_COLUMNS)
    .in('canonical_id', validIds);
  if (error || !data) return [];
  return (data as unknown as OpportunityRow[]).map(rowToCanonicalOpportunity);
}
