import { NextRequest, NextResponse } from 'next/server';
import { applyTranslationSafe, OPPORTUNITY_COLUMNS, rowToCanonicalOpportunity } from '@/lib/ingestion/catalog-read';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import type { CanonicalOpportunity } from '@/types/byn';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 160;
const MAX_TERMS = 5;
const COUNTRY_SCAN_BATCH_SIZE = 250;
const MAX_COUNTRY_CANDIDATES_SCANNED = 5_000;

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
  const variants = COUNTRY_ALIASES[country] ?? [country];
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

function publicJob(job: CanonicalOpportunity) {
  const detailUrl = jobUrl(job.sourceId);
  const isEmployerDirect = job.source === 'employerdirect';
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    companyLogo: job.companyLogo ?? null,
    description: job.description,
    employmentType: job.employmentType,
    remoteType: job.remoteType,
    eligibleCountries: job.eligibleCountries ?? [],
    excludedCountries: job.excludedCountries ?? [],
    timezoneRequirements: job.timezoneRequirements ?? [],
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    salaryCurrency: job.salaryCurrency ?? null,
    salaryPeriod: job.salaryPeriod ?? null,
    requiredSkills: job.requiredSkills ?? [],
    preferredSkills: job.preferredSkills ?? [],
    experienceRequirement: job.experienceRequirement ?? null,
    postedAt: job.postedAt,
    linkCheckedAt: job.linkCheckedAt ?? null,
    jobUrl: detailUrl,
    applicationUrl: isEmployerDirect ? detailUrl : job.officialUrl,
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
      .select(OPPORTUNITY_COLUMNS, { count: 'planned' })
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

    const accepted: CanonicalOpportunity[] = [];
    let candidateOffset = 0;
    let scanned = 0;
    let estimatedCandidateCount: number | null = null;
    let exhausted = false;
    const requiredAccepted = offsetRaw + limitRaw + 1;
    const scanBudget = country ? MAX_COUNTRY_CANDIDATES_SCANNED : requiredAccepted;

    while (accepted.length < requiredAccepted && scanned < scanBudget) {
      const batchSize = Math.min(COUNTRY_SCAN_BATCH_SIZE, scanBudget - scanned);
      const { data, count, error } = await query.range(candidateOffset, candidateOffset + batchSize - 1);
      if (error) throw new Error(`Could not search opportunities: ${error.message}`);
      if (estimatedCandidateCount === null) estimatedCandidateCount = count ?? null;

      const rows = (data ?? []) as unknown as Parameters<typeof rowToCanonicalOpportunity>[0][];
      scanned += rows.length;
      candidateOffset += rows.length;
      const canonicalRows = rows.map(rowToCanonicalOpportunity);
      for (const row of canonicalRows) {
        if (!isExcludedForCountry(row.excludedCountries, country)) accepted.push(row);
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

    const hasMore = accepted.length > offsetRaw + limitRaw;
    const opportunities = accepted.slice(offsetRaw, offsetRaw + limitRaw).map(publicJob);

    // The planner count is an estimate of eligible candidates before exclusions.
    // Never report less than the filtered page boundary; hasMore is exact from look-ahead.
    const total = Math.max(estimatedCandidateCount ?? 0, offsetRaw + opportunities.length + (hasMore ? 1 : 0));
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
