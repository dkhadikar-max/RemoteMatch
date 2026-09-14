import { JobProvider, RawJobPayload } from './types';
import { getApprovedEmployers, recordEmployerFetchSuccess, recordEmployerFetchFailure } from '../ingestion/employer-registry';

/**
 * Lever ATS adapter (Supply Discovery gate C3, docs/c3-implementation-plan.md).
 * Same registry-driven / per-employer-isolated shape as GreenhouseProvider —
 * see that file's header for the shared design rationale.
 */

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number; // epoch milliseconds
  categories?: {
    location?: string;
    department?: string;
    team?: string;
    allLocations?: string[];
  };
  workplaceType?: string;
  country?: string;
  descriptionPlain?: string;
}

async function fetchLeverBoard(boardSlug: string): Promise<LeverJob[]> {
  const res = await fetch(`https://api.lever.co/v0/postings/${boardSlug}?mode=json`, {
    headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Lever board '${boardSlug}' returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export class LeverProvider implements JobProvider {
  readonly name = 'Lever';
  readonly sourceKey = 'lever';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const employers = await getApprovedEmployers('lever');
    const results: RawJobPayload[] = [];

    for (const employer of employers) {
      try {
        const jobs = await fetchLeverBoard(employer.boardSlug);
        for (const job of jobs) {
          const locationParts = [
            job.categories?.location,
            job.workplaceType,
            job.country,
            ...(job.categories?.allLocations || []),
          ].filter(Boolean);
          results.push({
            sourceId: `lever-${employer.boardSlug}-${job.id}`,
            source: 'lever',
            title: job.text,
            company: employer.canonicalName,
            description: (job.descriptionPlain || '').slice(0, 1500),
            sourceUrl: job.hostedUrl,
            officialUrl: job.hostedUrl,
            jobType: 'Full-time',
            locationString: locationParts.join(', '),
            tags: [job.categories?.department, job.categories?.team].filter((t): t is string => Boolean(t)),
            // createdAt is Lever's genuine original-posting timestamp (epoch
            // ms) — there is no separate "updated" field that would make an
            // old job look freshly posted, so this is safe to trust directly
            // for the 48h freshness gate.
            publicationDate: new Date(job.createdAt).toISOString(),
          });
        }
        await recordEmployerFetchSuccess(employer.linkedSourceId, jobs.length);
      } catch (err) {
        await recordEmployerFetchFailure(employer.linkedSourceId);
        console.error(`[LeverProvider] employer '${employer.canonicalName}' (${employer.boardSlug}) fetch failed:`, err);
      }
    }

    return results;
  }
}
