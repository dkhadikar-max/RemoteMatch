import { NextRequest, NextResponse } from 'next/server';
import { applyTranslationSafe } from '@/lib/ingestion/catalog-read';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 160;
const MAX_TERMS = 5;
const COUNTRY_SCAN_BATCH_SIZE = 250;
const MAX_COUNTRY_CANDIDATES_SCANNED = 5_000;

// Keep this endpoint's database projection aligned with its public response.
// Avoid fetching internal scoring, translation, and reconciliation fields.
const CHATGPT_JOB_COLUMNS = [
  'title', 'company', 'company_logo', 'description', 'source', 'source_id',
  'official_url', 'employment_type', 'remote_type', 'eligible_countries',
  'excluded_countries', 'timezone_requirements', 'salary_min', 'salary_max',
  'salary_currency', 'salary_period', 'required_skills', 'preferred_skills',
  'experience_requirement', 'posted_at', 'link_checked_at',
].join(',');

type ChatGptJobRow = {
  title: string; company: string; company_logo: string | null; description: string;
  source: string; source_id: string; official_url: string; employment_type: string;
  remote_type: string; eligible_countries: string[] | null; excluded_countries: string[] | null;
  timezone_requirements: string[] | null; salary_min: number | null; salary_max: number | null;
  salary_currency: string | null; salary_period: string | null; required_skills: string[] | null;
  preferred_skills: string[] | null; experience_requirement: string | null;
  posted_at: string; link_checked_at: string | null;
};

function csv(value: string | null): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean).slice(0, 20);
}

function normalized(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function filterValue(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function searchTerms(value: string): string[] {
  return value.toLowerCase().split(/\s+/).map((term) => term.replace(/[^a-z0-9+#./-]/g, '').slice(0, 40)).filter(Boolean).slice(0, MAX_TERMS);
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  india: ['india', 'in'], in: ['india', 'in'],
  us: ['us', 'usa', 'united states'], usa: ['us', 'usa', 'united states'],
  'united states': ['us', 'usa', 'united states'],
  uk: ['uk', 'gb', 'united kingdom'], gb: ['uk', 'gb', 'united kingdom'],
  'united kingdom': ['uk', 'gb', 'united kingdom'],
  germany: ['germany'], deutschland: ['germany'],
  france: ['france'], netherlands: ['netherlands'], holland: ['netherlands'],
  ireland: ['ireland'], spain: ['spain'], italy: ['italy'], portugal: ['portugal'],
  sweden: ['sweden'], norway: ['norway'], denmark: ['denmark'], finland: ['finland'],
  poland: ['poland'], belgium: ['belgium'], austria: ['austria'], switzerland: ['switzerland'],
  czechia: ['czechia', 'czech republic'], 'czech republic': ['czechia', 'czech republic'],
  romania: ['romania'], greece: ['greece'], hungary: ['hungary'], bulgaria: ['bulgaria'],
  croatia: ['croatia'], slovakia: ['slovakia'], slovenia: ['slovenia'], estonia: ['estonia'],
  latvia: ['latvia'], lithuania: ['lithuania'], luxembourg: ['luxembourg'], cyprus: ['cyprus'],
  malta: ['malta'], iceland: ['iceland'], liechtenstein: ['liechtenstein'],
};

const EU_EEA_COUNTRIES = new Set([
  'austria','belgium','bulgaria','croatia','cyprus','czechia','czech republic','denmark',
  'estonia','finland','france','germany','greece','hungary','ireland','italy','latvia',
  'lithuania','luxembourg','malta','netherlands','poland','portugal','romania','slovakia',
  'slovenia','spain','sweden','iceland','liechtenstein','norway',
]);

function pgArray(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function countryVariants(country: string): string[] {
  const variants = [...(COUNTRY_ALIASES[country] ?? [country])];
  if (EU_EEA_COUNTRIES.has(country)) variants.push('EU', 'EEA', 'EU/EEA');
  return Array.from(new Set(variants.flatMap((value) => [
    value.toLowerCase(),
    value.toUpperCase(),
    value.charAt(0).toUpperCase() + value.slice(1),
  ])));
}

function applyCountryFilter<T extends { or(filters: string): T }>(query: T, country: string): T {
  if (!country) return query;
  const variants = COUNTRY_ALIASES[country] ?? [country];
  const arrayVariants = countryVariants(country);
  const clauses = [
    'remote_type.eq.worldwide',
    `eligible_countries.ov.${pgArray(arrayVariants)}`,
    ...variants.map((value) => `and(eligible_countries.is.null,remote_type.eq.${value.replace(/[^a-z0-9 /-]/g, '')})`),
    ...variants.map((value) => `and(eligible_countries.eq.{},remote_type.eq.${value.replace(/[^a-z0-9 /-]/g, '')})`),
  ];
  if (EU_EEA_COUNTRIES.has(country)) {
    clauses.push('eligible_countries.ov.{"EU","EEA","EU/EEA"}', 'remote_type.eq.eu/eea');
  }
  return query.or(clauses.join(','));
}

function isExcludedForCountry(excludedCountries: string[] | null | undefined, country: string): boolean {
  if (!country || !Array.isArray(excludedCountries) || excludedCountries.length === 0) return false;
  const variants = new Set(countryVariants(country).map((value) => value.toLowerCase()));
  return excludedCountries.some((value) => variants.has(String(value).trim().toLowerCase()));
}

function publicJob(job: ChatGptJobRow) {
  const detailUrl = jobUrl(job.source_id);
  const isEmployerDirect = job.source === 'employerdirect';
  return {
    id: `opp-${job.source}-${job.source_id}`,
    title: job.title,
    company: job.company,
    companyLogo: job.company_logo ?? null,
    description: job.description,
    employmentType: job.employment_type,
    remoteType: job.remote_type,
    eligibleCountries: job.eligible_countries ?? [],
    excludedCountries: job.excluded_countries ?? [],
    timezoneRequirements: job.timezone_requirements ?? [],
    salaryMin: job.salary_min ?? null,
    salaryMax: job.salary_max ?? null,
    salaryCurrency: job.salary_currency ?? null,
    salaryPeriod: job.salary_period ?? null,
    requiredSkills: job.required_skills ?? [],
    preferredSkills: job.preferred_skills ?? [],
    experienceRequirement: job.experience_requirement ?? null,
    postedAt: job.posted_at,
    linkCheckedAt: job.link_checked_at ?? null,
    jobUrl: detailUrl,
    applicationUrl: isEmployerDirect ? detailUrl : job.official_url,
    applicationMethod: isEmployerDirect ? 'RemoteMatch in-platform application' : 'Employer website',
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const rawQuery = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const queryTerms = searchTerms(rawQuery);
  const skills = csv(params.get('skills'));
  const country = normalized(params.get('country'));
  const remoteType = filterValue(params.get('remoteType'));
  const employmentType = filterValue(params.get('employmentType'));
  const salaryCurrency = filterValue(params.get('salaryCurrency'));
  const experience = filterValue(params.get('experience'));
  const minSalaryRaw = params.get('minSalary');
  const minSalary = minSalaryRaw === null ? null : Number(minSalaryRaw);

  if (minSalary !== null && (!Number.isFinite(minSalary) || minSalary < 0 || minSalary > 1_000_000_000)) {
    return NextResponse.json({ success: false, error: 'Invalid minSalary.' }, { status: 400 });
  }

  const limitRaw = Number(params.get('limit') ?? DEFAULT_LIMIT);
  const offsetRaw = Number(params.get('offset') ?? 0);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT ||
      !Number.isInteger(offsetRaw) || offsetRaw < 0 || offsetRaw > 100_000) {
    return NextResponse.json({ success: false, error: 'Invalid pagination. limit must be 1-25 and offset must be 0-100000.' }, { status: 400 });
  }

  try {
    // This is a deliberately public, session-independent catalogue endpoint.
    // Use the server-only service client so PostgreSQL can use the catalogue's
    // partial trigram indexes; anon RLS security quals prevent those indexes
    // from being selected for ILIKE predicates. Public visibility is enforced
    // explicitly below (active, not superseded, translation-safe), and only
    // the allow-listed publicJob projection is returned.
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Job catalogue temporarily unavailable.' }, { status: 503 });
    }

    let query = supabase
      .from('opportunities')
      // A multi-term ILIKE search can make an exact count scan the full catalog
      // twice (page + count) and hit the 3s Postgres timeout. Planned count is
      // bounded; hasMore is exact from the extra row fetched below.
      .select(CHATGPT_JOB_COLUMNS, { count: 'planned' })
      .eq('status', 'active')
      .is('superseded_by_opportunity_id', null);

    query = applyTranslationSafe(query);
    for (const term of queryTerms) {
      const clauses = [
        `title.ilike.*${term}*`,
        `company.ilike.*${term}*`,
        `description.ilike.*${term}*`,
        ...[term, term.charAt(0).toUpperCase() + term.slice(1), term.toUpperCase()]
          .map((variant) => `required_skills.cs.{${variant}}`),
      ];
      query = query.or(clauses.join(','));
    }

    for (const skill of skills) {
      const variants = Array.from(new Set([skill, skill.toLowerCase(), skill.charAt(0).toUpperCase() + skill.slice(1), skill.toUpperCase()]));
      const clauses = [
        ...variants.map((variant) => `required_skills.cs.{${variant}}`),
        ...variants.map((variant) => `preferred_skills.cs.{${variant}}`),
      ];
      query = query.or(clauses.join(','));
    }

    query = applyCountryFilter(query, country);
    if (remoteType) query = query.ilike('remote_type', remoteType);
    if (employmentType) query = query.ilike('employment_type', employmentType);
    if (experience) query = query.ilike('experience_requirement', experience);
    if (salaryCurrency) {
      query = query.not('salary_currency', 'is', null).ilike('salary_currency', salaryCurrency)
        .or('salary_min.not.is.null,salary_max.not.is.null');
    }
    if (minSalary !== null) query = query.gte('salary_min', minSalary);

    query = query
      .order('posted_at', { ascending: false, nullsFirst: false })
      .order('source_id', { ascending: true });

    const accepted: ChatGptJobRow[] = [];
    let candidateOffset = country ? 0 : offsetRaw;
    let scanned = 0;
    let estimatedCandidateCount: number | null = null;
    let exhausted = false;
    const requiredAccepted = country ? offsetRaw + limitRaw + 1 : limitRaw + 1;
    const scanBudget = country ? MAX_COUNTRY_CANDIDATES_SCANNED : requiredAccepted;

    while (accepted.length < requiredAccepted && scanned < scanBudget) {
      const batchSize = Math.min(COUNTRY_SCAN_BATCH_SIZE, scanBudget - scanned);
      const { data, count, error } = await query.range(candidateOffset, candidateOffset + batchSize - 1);
      if (error) throw new Error(`Could not search opportunities: ${error.message}`);
      if (estimatedCandidateCount === null) estimatedCandidateCount = count ?? null;

      const rows = (data ?? []) as unknown as ChatGptJobRow[];
      scanned += rows.length;
      candidateOffset += rows.length;
      for (const row of rows) {
        if (!isExcludedForCountry(row.excluded_countries, country)) accepted.push(row);
      }

      if (rows.length < batchSize) {
        exhausted = true;
        break;
      }
    }

    // Do not return a silently incomplete page when exclusions consume the bounded scan budget.
    if (accepted.length < requiredAccepted && !exhausted && scanned >= scanBudget) {
      return NextResponse.json({
        success: false,
        error: 'Country-filtered search is temporarily too broad. Narrow your search and retry.',
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    const hasMore = country
      ? accepted.length > offsetRaw + limitRaw
      : accepted.length > limitRaw;
    const opportunities = (country
      ? accepted.slice(offsetRaw, offsetRaw + limitRaw)
      : accepted.slice(0, limitRaw)).map(publicJob);

    // The planner count is an estimate of eligible candidates before exclusions.
    // Never report less than the page boundary; hasMore is exact from look-ahead.
    const total = Math.max(estimatedCandidateCount ?? 0,
      offsetRaw + opportunities.length + (hasMore ? 1 : 0));
    return NextResponse.json({
      success: true,
      total,
      totalIsEstimate: true,
      limit: limitRaw,
      offset: offsetRaw,
      hasMore,
      opportunities,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[chatgpt-jobs] database search failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: 'Could not search the job catalogue.' }, { status: 503 });
  }
}
