import { JobProvider, RawJobPayload } from './types';

export class ArbeitnowProvider implements JobProvider {
  readonly name = 'Arbeitnow Remote API';
  readonly sourceKey = 'arbeitnow';

  async fetchJobs(): Promise<RawJobPayload[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch('https://www.arbeitnow.com/api/job-board-api', {
        signal: controller.signal,
        headers: {
          'User-Agent': 'RemoteMatch-BYN/1.0',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`Arbeitnow API returned ${res.status}`);
        return [];
      }

      const data = await res.json();
      const jobs = data.data || [];

      // Filter only remote jobs
      const remoteJobs = jobs.filter((job: any) => job.remote === true);

      return remoteJobs.slice(0, 20).map((job: any): RawJobPayload => {
        const isContract = (job.tags || []).some((t: string) => t.toLowerCase().includes('contract')) ||
          (job.title || '').toLowerCase().includes('contract');
        const isFreelance = (job.tags || []).some((t: string) => t.toLowerCase().includes('freelance'));
        const isPartTime = (job.tags || []).some((t: string) => t.toLowerCase().includes('part'));

        return {
          sourceId: String(job.slug || job.id || Math.random().toString(36).substring(7)),
          source: 'arbeitnow',
          title: job.title || 'Untitled Role',
          company: job.company_name || 'Anonymous',
          description: (job.description || '').replace(/<[^>]*>?/gm, ' ').slice(0, 1500),
          sourceUrl: job.url,
          officialUrl: job.url,
          jobType: isContract ? 'Contract' : isFreelance ? 'Freelance' : isPartTime ? 'Part-time' : 'Full-time',
          locationString: job.location || 'Worldwide',
          tags: Array.isArray(job.tags) ? job.tags : [],
          publicationDate: job.created_at ? new Date(job.created_at * 1000).toISOString() : new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn('Arbeitnow fetch failed (using empty/fallback):', (err as Error).message);
      return [];
    }
  }
}
