import { JobProvider, RawJobPayload } from './types';

export class RemotiveProvider implements JobProvider {
  readonly name = 'Remotive Remote Jobs';
  readonly sourceKey = 'remotive';

  async fetchJobs(): Promise<RawJobPayload[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch('https://remotive.com/api/remote-jobs?limit=25', {
        signal: controller.signal,
        headers: {
          'User-Agent': 'RemoteMatch/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`Remotive API responded with status ${res.status}`);
        return [];
      }

      const data = await res.json();
      const jobs = data.jobs || [];

      return jobs.map((job: any): RawJobPayload => {
        return {
          sourceId: String(job.id),
          source: 'remotive',
          title: job.title || 'Untitled Opportunity',
          company: job.company_name || 'Anonymous Company',
          companyLogo: job.company_logo,
          description: (job.description || '').replace(/<[^>]*>?/gm, ' ').slice(0, 1500),
          sourceUrl: job.url,
          officialUrl: job.url,
          jobType: job.job_type === 'full_time' ? 'Full-time' : job.job_type === 'contract' ? 'Contract' : 'Full-time',
          locationString: job.candidate_required_location || 'Worldwide',
          salaryString: job.salary || undefined,
          tags: Array.isArray(job.tags) ? job.tags : [],
          publicationDate: job.publication_date || new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn('Remotive fetch failed (using empty/fallback):', (err as Error).message);
      return [];
    }
  }
}
