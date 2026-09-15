import { JobProvider, RawJobPayload } from './types';

/**
 * C5-B — Jobicy Remote Jobs API
 * Supports count (up to 50) and page query params.
 * MAX_PAGES=3 gives a ceiling of 150 items per run before the downstream
 * freshness gate filters stale ones — same bounded-pagination pattern as
 * HimalayasProvider, partial results returned on any page failure.
 */

const MAX_PAGES = 3;

function mapJobType(jobType: string | string[]): 'Full-time' | 'Part-time' | 'Contract' | 'Freelance' {
  const raw = (Array.isArray(jobType) ? jobType.join(' ') : String(jobType || '')).toLowerCase();
  if (raw.includes('contract')) return 'Contract';
  if (raw.includes('freelance')) return 'Freelance';
  if (raw.includes('part')) return 'Part-time';
  return 'Full-time';
}

export class JobicyProvider implements JobProvider {
  readonly name = 'Jobicy Remote Jobs API';
  readonly sourceKey = 'jobicy';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const allJobs: RawJobPayload[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(`https://jobicy.com/api/v2/remote-jobs?count=50&page=${page}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'RemoteMatch/1.0' },
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          console.warn(`Jobicy API returned ${res.status} on page ${page}`);
          break; // partial results from earlier pages are still returned
        }

        const data = await res.json();
        const jobs = data.jobs || [];
        if (jobs.length === 0) break; // no more pages

        for (const job of jobs) {
          const minSal = job.annualSalaryMin ? Number(job.annualSalaryMin) : undefined;
          const maxSal = job.annualSalaryMax ? Number(job.annualSalaryMax) : undefined;

          const tags: string[] = [];
          if (job.jobIndustry) {
            if (Array.isArray(job.jobIndustry)) tags.push(...job.jobIndustry);
            else tags.push(String(job.jobIndustry));
          }

          allJobs.push({
            sourceId: String(job.id || Math.random().toString(36).substring(7)),
            source: 'jobicy',
            title: job.jobTitle || 'Untitled Role',
            company: job.companyName || 'Anonymous Company',
            companyLogo: job.companyLogo,
            description: (job.jobDescription || '').replace(/<[^>]*>?/gm, ' ').slice(0, 1500),
            sourceUrl: job.url,
            officialUrl: job.url,
            jobType: mapJobType(job.jobType),
            locationString: job.jobGeo || 'Worldwide',
            salaryMin: minSal,
            salaryMax: maxSal,
            salaryCurrency: job.salaryCurrency || 'USD',
            salaryPeriod: (minSal || maxSal) ? 'yearly' : undefined,
            tags,
            publicationDate: job.pubDate || new Date().toISOString(),
            experienceLevel: job.jobLevel || '2-3',
          });
        }
      }

      return allJobs;
    } catch (err) {
      console.warn('Jobicy fetch failed (using partial/empty results so far):', (err as Error).message);
      return allJobs;
    }
  }
}
