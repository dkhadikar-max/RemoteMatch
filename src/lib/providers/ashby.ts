import { JobProvider, RawJobPayload } from './types';
import { getApprovedEmployers, recordEmployerFetchSuccess, recordEmployerFetchFailure } from '../ingestion/employer-registry';

/**
 * Ashby ATS adapter (Supply Discovery gate C3, docs/c3-implementation-plan.md).
 * Same registry-driven / per-employer-isolated shape as GreenhouseProvider —
 * see that file's header for the shared design rationale.
 *
 * Ashby gives the richest structured signal of the three (per the B2 spike's
 * own finding, re-confirmed live): a genuine `isRemote` boolean and
 * `workplaceType`, rather than free-text-only location like Greenhouse.
 * That structured signal is folded into `locationString`/`tags` here so
 * classifyExplicitRemoteScope() (unchanged, reused as-is) sees it — this
 * adapter does not bypass or duplicate that classifier.
 */

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  location?: string;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
}

async function fetchAshbyBoard(boardSlug: string): Promise<AshbyJob[]> {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${boardSlug}`, {
    headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Ashby board '${boardSlug}' returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export class AshbyProvider implements JobProvider {
  readonly name = 'Ashby';
  readonly sourceKey = 'ashby';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const employers = await getApprovedEmployers('ashby');
    const results: RawJobPayload[] = [];

    for (const employer of employers) {
      try {
        const jobs = await fetchAshbyBoard(employer.boardSlug);
        for (const job of jobs) {
          const locationParts = [
            job.isRemote ? 'Remote' : null,
            job.workplaceType,
            job.location,
          ].filter(Boolean);
          results.push({
            sourceId: `ashby-${employer.boardSlug}-${job.id}`,
            source: 'ashby',
            title: job.title,
            company: employer.canonicalName,
            description: (job.descriptionPlain || '').slice(0, 1500),
            sourceUrl: job.jobUrl,
            officialUrl: job.applyUrl || job.jobUrl,
            jobType: 'Full-time',
            locationString: locationParts.join(', '),
            tags: [job.department, job.team].filter((t): t is string => Boolean(t)),
            // publishedAt is Ashby's genuine original-posting timestamp. If
            // it's ever absent, an empty string is passed through
            // deliberately rather than falling back to "now" — that would
            // make an undated job look freshly-posted and defeat the 48h
            // freshness gate. passesFreshnessGate() treats a falsy/
            // unparseable value as reject, which is the correct outcome.
            publicationDate: job.publishedAt || '',
          });
        }
        await recordEmployerFetchSuccess(employer.linkedSourceId, jobs.length);
      } catch (err) {
        await recordEmployerFetchFailure(employer.linkedSourceId);
        console.error(`[AshbyProvider] employer '${employer.canonicalName}' (${employer.boardSlug}) fetch failed:`, err);
      }
    }

    return results;
  }
}
