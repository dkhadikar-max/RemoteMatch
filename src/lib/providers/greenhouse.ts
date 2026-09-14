import { JobProvider, RawJobPayload } from './types';
import { getApprovedEmployers, recordEmployerFetchSuccess, recordEmployerFetchFailure } from '../ingestion/employer-registry';

/**
 * Greenhouse ATS adapter (Supply Discovery gate C3, docs/c3-implementation-plan.md).
 *
 * Registry-driven: the employer list comes from `allowlist_employers`
 * (ats_provider='greenhouse', review_status='approved'), not a hardcoded
 * list — this is what makes ingestion "registry-driven" per the C3 plan,
 * as distinct from the 4 pre-existing singleton providers.
 *
 * Per-employer failure isolation: one employer's fetch failure is caught
 * and recorded on its own supply_sources row; the loop always continues to
 * the next employer. A total failure of every employer still resolves
 * (never throws) — the whole platform is never marked failed just because
 * one board is unreachable.
 *
 * `content` is double-HTML-encoded by Greenhouse's public API (confirmed
 * live 2026-09 — the field is itself an escaped HTML string inside JSON:
 * "&lt;div&gt;...&lt;/div&gt;"), so it must be entity-decoded BEFORE the
 * usual tag-strip, or the escaped tags never match the strip regex.
 */

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  first_published?: string;
  location?: { name?: string };
  content?: string;
  departments?: { name: string }[];
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function stripHtml(html: string): string {
  return decodeHtmlEntities(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchGreenhouseBoard(boardSlug: string): Promise<GreenhouseJob[]> {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs?content=true`, {
    headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Greenhouse board '${boardSlug}' returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export class GreenhouseProvider implements JobProvider {
  readonly name = 'Greenhouse';
  readonly sourceKey = 'greenhouse';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const employers = await getApprovedEmployers('greenhouse');
    const results: RawJobPayload[] = [];

    for (const employer of employers) {
      try {
        const jobs = await fetchGreenhouseBoard(employer.boardSlug);
        for (const job of jobs) {
          results.push({
            sourceId: `greenhouse-${employer.boardSlug}-${job.id}`,
            source: 'greenhouse',
            title: job.title,
            company: employer.canonicalName,
            description: stripHtml(job.content || '').slice(0, 1500),
            sourceUrl: job.absolute_url,
            officialUrl: job.absolute_url,
            jobType: 'Full-time',
            locationString: job.location?.name || '',
            tags: (job.departments || []).map((d) => d.name),
            // first_published is the genuine original posting date (present
            // for every job observed live) — updated_at changes on any edit
            // and would make an old job look freshly-posted, defeating the
            // 48h freshness gate. Fall back to updated_at only if
            // first_published is ever absent, never invent a date.
            publicationDate: job.first_published || job.updated_at,
          });
        }
        await recordEmployerFetchSuccess(employer.linkedSourceId, jobs.length);
      } catch (err) {
        // Per-employer isolation: log and continue — never let one
        // employer's failure stop the rest of this provider's run, and
        // never let it propagate as a whole-platform failure.
        await recordEmployerFetchFailure(employer.linkedSourceId);
        console.error(`[GreenhouseProvider] employer '${employer.canonicalName}' (${employer.boardSlug}) fetch failed:`, err);
      }
    }

    return results;
  }
}
