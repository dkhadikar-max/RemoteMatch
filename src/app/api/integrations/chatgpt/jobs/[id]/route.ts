import { NextRequest, NextResponse } from 'next/server';
import { applyTranslationSafe } from '@/lib/ingestion/catalog-read';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

// Keep the details projection aligned with the public search response. A
// details lookup must be a point query, not a full-catalog cache hydration.
const CHATGPT_JOB_COLUMNS = [
  'title', 'company', 'company_logo', 'description', 'source', 'source_id',
  'official_url', 'employment_type', 'remote_type', 'eligible_countries',
  'excluded_countries', 'timezone_requirements', 'salary_min', 'salary_max',
  'salary_currency', 'salary_period', 'required_skills', 'preferred_skills',
  'experience_requirement', 'posted_at', 'link_checked_at',
].join(',');

type ChatGptJobRow = {
  title: string;
  company: string;
  company_logo: string | null;
  description: string;
  source: string;
  source_id: string;
  official_url: string;
  employment_type: string;
  remote_type: string;
  eligible_countries: string[] | null;
  excluded_countries: string[] | null;
  timezone_requirements: string[] | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  required_skills: string[] | null;
  preferred_skills: string[] | null;
  experience_requirement: string | null;
  posted_at: string;
  link_checked_at: string | null;
};

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

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id: encodedId } = context.params;
  let id: string;
  try {
    // Next.js preserves encoded dynamic route segments. Decode once so source
    // IDs containing slashes or percent escapes resolve to their canonical ID.
    id = decodeURIComponent(encodedId);
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid opportunity ID.' }, { status: 400 });
  }
  if (!id || id.length > 512 || !/^opp-[a-z0-9_]+-/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Invalid opportunity ID.' }, { status: 400 });
  }

  // Canonical IDs are opp-{source}-{source_id}; source identifiers in the
  // catalog are lowercase alphanumeric/underscore values, while source_id may
  // itself contain any number of hyphens.
  const canonicalBody = id.slice(4);
  const separator = canonicalBody.indexOf('-');
  const source = canonicalBody.slice(0, separator).toLowerCase();
  const sourceId = canonicalBody.slice(separator + 1);
  if (!source || !sourceId) {
    return NextResponse.json({ success: false, error: 'Invalid opportunity ID.' }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Job catalogue temporarily unavailable.' }, { status: 503 });
    }

    let query = supabase
      .from('opportunities')
      .select(CHATGPT_JOB_COLUMNS)
      .eq('source', source)
      .eq('source_id', sourceId)
      .eq('status', 'active')
      .is('superseded_by_opportunity_id', null);
    query = applyTranslationSafe(query);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ success: false, error: 'Active job not found.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      opportunity: publicJob(data as unknown as ChatGptJobRow),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[chatgpt-job-details] lookup failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: 'Could not retrieve the job.' }, { status: 503 });
  }
}
