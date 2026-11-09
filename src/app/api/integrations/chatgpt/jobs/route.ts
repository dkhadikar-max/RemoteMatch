import { NextRequest, NextResponse } from 'next/server';
import { getFeedCatalog } from '@/lib/feed/catalog-cache';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 160;

function csv(value: string | null): string[] {
  return (value ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean).slice(0, 20);
}

function normalized(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function matchesCountry(job: Awaited<ReturnType<typeof getFeedCatalog>> extends (infer T)[] | null ? T : never, country: string): boolean {
  if (!country) return true;
  const remote = normalized(job.remoteType);
  const eligible = (job.eligibleCountries ?? []).map(normalized);
  const excluded = (job.excludedCountries ?? []).map(normalized);
  if (excluded.includes(country)) return false;
  if (remote === 'worldwide') return true;
  if (remote === 'india') return country === 'india' || country === 'in';
  if (remote === 'us') return country === 'us' || country === 'usa' || country === 'united states';
  if (eligible.length > 0) return eligible.includes(country);
  return remote === country;
}

function publicJob(job: NonNullable<Awaited<ReturnType<typeof getFeedCatalog>>>[number]) {
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
  const queryTerms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const skills = csv(params.get('skills'));
  const country = normalized(params.get('country'));
  const remoteType = normalized(params.get('remoteType'));
  const employmentType = normalized(params.get('employmentType'));
  const salaryCurrency = normalized(params.get('salaryCurrency'));
  const experience = normalized(params.get('experience'));
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
    const catalog = await getFeedCatalog();
    if (!catalog) {
      return NextResponse.json({ success: false, error: 'Job catalogue temporarily unavailable.' }, { status: 503 });
    }

    const filtered = catalog
      .filter((job) => job.status === 'active' && !job.supersededByOpportunityId)
      .filter((job) => queryTerms.length === 0 || queryTerms.every((term) =>
        [job.title, job.company, job.description, ...(job.requiredSkills ?? [])].join(' ').toLowerCase().includes(term)
      ))
      .filter((job) => skills.length === 0 || skills.every((skill) =>
        (job.requiredSkills ?? []).some((required) => normalized(required).includes(skill)) ||
        (job.preferredSkills ?? []).some((preferred) => normalized(preferred).includes(skill))
      ))
      .filter((job) => matchesCountry(job, country))
      .filter((job) => !remoteType || normalized(job.remoteType) === remoteType)
      .filter((job) => !employmentType || normalized(job.employmentType) === employmentType)
      .filter((job) => !experience || normalized(job.experienceRequirement).includes(experience))
      .filter((job) => !salaryCurrency || normalized(job.salaryCurrency) === salaryCurrency)
      .filter((job) => minSalary === null || (job.salaryMin !== undefined && job.salaryMin >= minSalary));

    filtered.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
    const total = filtered.length;
    const opportunities = filtered.slice(offsetRaw, offsetRaw + limitRaw).map(publicJob);

    return NextResponse.json({
      success: true,
      total,
      limit: limitRaw,
      offset: offsetRaw,
      hasMore: offsetRaw + opportunities.length < total,
      opportunities,
    }, {
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not search the job catalogue.' }, { status: 503 });
  }
}
