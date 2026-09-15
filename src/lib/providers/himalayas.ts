import { JobProvider, RawJobPayload } from './types';

/**
 * C5-B — Himalayas public job API
 * (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §2, real-verified
 * 2026-09-15: public, no auth, robots.txt Allow: / on the API path,
 * confirmed real per-job pubDate/expiryDate/locationRestrictions/
 * applicationLink fields at scale, cursor-paginated per the API's own
 * documented `nextCursor` mechanism).
 * ==============================================================================
 * Same JobProvider interface and shared downstream pipeline as every other
 * source, mirroring RemotiveProvider's established shape.
 *
 * Bounded pagination, deliberately: the API's `totalCount` (105k+ at
 * verification time) is a historical+active total, not "currently open"
 * — pulling the entire dataset every sync would be both wasteful and
 * pointless (old/expired postings get filtered downstream by the existing,
 * unmodified freshness gate regardless). MAX_PAGES caps this to a small,
 * fast, bounded number of most-recent pages per sync cycle, matching this
 * project's stated preference for measurement-driven scope over
 * pre-optimizing for volume that hasn't been shown to matter yet.
 *
 * officialUrl points at Himalayas' own listing page (`applicationLink`),
 * not the employer's own site — same accepted aggregator pattern as
 * RemotiveProvider/WeWorkRemotelyProvider.
 */

const API_URL = 'https://himalayas.app/jobs/api';
const PAGE_SIZE = 20;
const MAX_PAGES = 3;

interface HimalayasJob {
  title: string;
  companyName: string;
  employmentType?: string;
  locationRestrictions?: string[];
  categories?: string[];
  description?: string;
  pubDate?: number;
  applicationLink: string;
  guid: string;
}

interface HimalayasResponse {
  jobs: HimalayasJob[];
  nextCursor?: string | null;
}

export class HimalayasProvider implements JobProvider {
  readonly name = 'Himalayas';
  readonly sourceKey = 'himalayas';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const jobs: RawJobPayload[] = [];
    let cursor: string | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(API_URL);
        url.searchParams.set('limit', String(PAGE_SIZE));
        if (cursor) url.searchParams.set('cursor', cursor);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          console.warn(`Himalayas API responded with status ${res.status} on page ${page}`);
          break; // partial results from earlier pages are still returned, not discarded
        }

        const data: HimalayasResponse = await res.json();
        const pageJobs = Array.isArray(data.jobs) ? data.jobs : [];

        for (const job of pageJobs) {
          if (!job.guid || !job.title || !job.companyName) continue; // no stable identity or core fields, skip

          const locationString = Array.isArray(job.locationRestrictions) && job.locationRestrictions.length > 0
            ? job.locationRestrictions.join(', ')
            : 'Worldwide';

          jobs.push({
            sourceId: job.guid,
            source: this.sourceKey,
            title: job.title,
            company: job.companyName,
            description: (job.description || '').replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
            sourceUrl: job.applicationLink,
            officialUrl: job.applicationLink,
            jobType: job.employmentType === 'FULL_TIME' ? 'Full-time'
              : job.employmentType === 'PART_TIME' ? 'Part-time'
              : job.employmentType === 'CONTRACT' ? 'Contract'
              : job.employmentType === 'INTERNSHIP' ? 'Internship'
              : 'Full-time',
            locationString,
            tags: Array.isArray(job.categories) ? job.categories : [],
            publicationDate: job.pubDate ? new Date(job.pubDate * 1000).toISOString() : new Date().toISOString(),
          });
        }

        if (!data.nextCursor || pageJobs.length === 0) break; // reached the end of available pages
        cursor = data.nextCursor;
      }

      return jobs;
    } catch (err) {
      console.warn('Himalayas fetch failed (using partial/empty results so far):', (err as Error).message);
      return jobs; // return whatever pages succeeded before the failure, matching the pattern above
    }
  }
}
