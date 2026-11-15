import { NextRequest, NextResponse } from 'next/server';
import { getActiveOpportunityByCanonicalId } from '@/lib/ingestion/catalog-read';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
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
  if (!id || id.length > 512 || !/^opp-[a-z0-9_-]+-/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Invalid opportunity ID.' }, { status: 400 });
  }

  try {
    const supabase = createSupabasePublicClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Job catalogue temporarily unavailable.' }, { status: 503 });
    }

    // canonical_id has a unique B-tree index. Resolve one row directly rather
    // than warming the full feed catalogue (thousands of rows) for one detail.
    const job = await getActiveOpportunityByCanonicalId(supabase, id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Active job not found.' }, { status: 404 });
    }

    const detailUrl = jobUrl(job.sourceId);
    const isEmployerDirect = job.source === 'employerdirect';
    return NextResponse.json({
      success: true,
      opportunity: {
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
      },
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not retrieve the job.' }, { status: 503 });
  }
}
