import { NextRequest, NextResponse } from 'next/server';
import { getFeedCatalog } from '@/lib/feed/catalog-cache';
import { jobUrl } from '@/lib/seo/job-href';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.length > 240 || !/^opp-[a-z0-9_-]+-[^/]+$/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Invalid opportunity ID.' }, { status: 400 });
  }

  try {
    const catalog = await getFeedCatalog();
    if (!catalog) {
      return NextResponse.json({ success: false, error: 'Job catalogue temporarily unavailable.' }, { status: 503 });
    }

    const job = catalog.find((item) => item.id === id && item.status === 'active' && !item.supersededByOpportunityId);
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
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not retrieve the job.' }, { status: 503 });
  }
}
