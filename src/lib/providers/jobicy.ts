import { JobProvider, RawJobPayload } from './types';

export class JobicyProvider implements JobProvider {
  readonly name = 'Jobicy Remote Jobs API';
  readonly sourceKey = 'jobicy';

  async fetchJobs(): Promise<RawJobPayload[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=25', {
        signal: controller.signal,
        headers: {
          'User-Agent': 'RemoteMatch/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`Jobicy API returned ${res.status}`);
        return [];
      }

      const data = await res.json();
      const jobs = data.jobs || [];

      return jobs.map((job: any): RawJobPayload => {
        const minSal = job.annualSalaryMin ? Number(job.annualSalaryMin) : undefined;
        const maxSal = job.annualSalaryMax ? Number(job.annualSalaryMax) : undefined;

        // Extract tags or industry
        const tags: string[] = [];
        if (job.jobIndustry) {
          if (Array.isArray(job.jobIndustry)) tags.push(...job.jobIndustry);
          else tags.push(String(job.jobIndustry));
        }

        return {
          sourceId: String(job.id || Math.random().toString(36).substring(7)),
          source: 'jobicy',
          title: job.jobTitle || 'Untitled Role',
          company: job.companyName || 'Anonymous Company',
          companyLogo: job.companyLogo,
          description: (job.jobDescription || '').replace(/<[^>]*>?/gm, ' ').slice(0, 1500),
          sourceUrl: job.url,
          officialUrl: job.url,
          jobType: (Array.isArray(job.jobType) ? job.jobType.join(' ') : String(job.jobType || '')).toLowerCase().includes('contract')
            ? 'Contract'
            : (Array.isArray(job.jobType) ? job.jobType.join(' ') : String(job.jobType || '')).toLowerCase().includes('freelance')
            ? 'Freelance'
            : (Array.isArray(job.jobType) ? job.jobType.join(' ') : String(job.jobType || '')).toLowerCase().includes('part')
            ? 'Part-time'
            : 'Full-time',
          locationString: job.jobGeo || 'Worldwide',
          salaryMin: minSal,
          salaryMax: maxSal,
          salaryCurrency: job.salaryCurrency || 'USD',
          tags,
          publicationDate: job.pubDate || new Date().toISOString(),
          experienceLevel: job.jobLevel || '2-3',
        };
      });
    } catch (err) {
      console.warn('Jobicy fetch failed (using empty/fallback):', (err as Error).message);
      return [];
    }
  }
}
