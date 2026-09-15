import { JobProvider, RawJobPayload } from './types';

/**
 * C5-B -- RemoteOK public JSON API
 * robots.txt: User-agent: * Allow: / with Content-Signal: search=yes.
 * Job ingestion for aggregation/search is explicitly permitted.
 * Verified 2026-09-15.
 *
 * Per-item epoch is a Unix timestamp used as publicationDate, giving the
 * downstream freshness gate precise age data. The API's first element is a
 * metadata header record (id=null) -- skipped via the id/title guard.
 *
 * officialUrl points at RemoteOK's own listing page (the url field) --
 * same accepted aggregator pattern as WeWorkRemotelyProvider and
 * RemotiveProvider.
 */

const API_URL = 'https://remoteok.com/api';

export class RemoteOKProvider implements JobProvider {
  readonly name = 'RemoteOK';
  readonly sourceKey = 'remoteok';

  async fetchJobs(): Promise<RawJobPayload[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(API_URL, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)',
          'Accept': 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn('RemoteOK API responded with status ' + res.status);
        return [];
      }

      const data = await res.json();
      if (!Array.isArray(data)) {
        console.warn('RemoteOK API returned unexpected shape (not array)');
        return [];
      }

      const jobs: RawJobPayload[] = [];
      for (const job of data) {
        // First element is a metadata header record (id=null) -- skip it
        // and any other non-posting entries without stable identity or title.
        const id = String(job.id ?? '');
        if (!id || id === 'null' || !job.position) continue;

        const tags: string[] = Array.isArray(job.tags) ? job.tags.map(String) : [];
        const locationString = job.location ? String(job.location) : 'Worldwide';
        const publicationDate = job.epoch
          ? new Date(job.epoch * 1000).toISOString()
          : new Date().toISOString();

        jobs.push({
          sourceId: id,
          source: this.sourceKey,
          title: String(job.position),
          company: String(job.company ?? 'Unknown Company'),
          companyLogo: job.company_logo ? String(job.company_logo) : undefined,
          description: job.description
            ? String(job.description).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500)
            : '',
          sourceUrl: String(job.url),
          officialUrl: String(job.url),
          jobType: 'Full-time',
          locationString,
          salaryString: job.salary ? String(job.salary) : undefined,
          tags,
          publicationDate,
        });
      }

      return jobs;
    } catch (err) {
      console.warn('RemoteOK fetch failed (using empty/fallback):', (err as Error).message);
      return [];
    }
  }
}
