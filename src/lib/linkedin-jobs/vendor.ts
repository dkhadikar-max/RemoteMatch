import type { LinkedInJobSearchFilters, VendorJobResult } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — automated discovery vendor adapter (plan §22/§23).
 *
 * RemoteMatch never fetches linkedin.com directly (see docs/additional-
 * supply-discovery-spec.md and docs/c5-audit.md, which already, separately,
 * rule LinkedIn out as a scrapeable acquisition source). Instead, this
 * calls a LICENSED THIRD-PARTY reseller of Google's own "Google for Jobs"
 * aggregation (real, primary-source-verified research: Google's Custom
 * Search JSON API is closed to new customers, Bing's Search API is fully
 * retired — this vendor lane is what remains, self-service, today) and
 * filters its raw results down to only those carrying a real linkedin.com
 * apply option — see filterToLinkedInResults() below.
 *
 * `JobSearchVendor` is an injectable interface (mirroring this project's
 * own JobProvider pattern in src/lib/providers/types.ts) precisely so the
 * surrounding route/filtering/normalization logic is real-infra-testable
 * with a fake implementation, without needing a live vendor API key —
 * see test/linkedin-jobs-vendor-suite.ts.
 */
export interface JobSearchVendor {
  readonly name: string;
  /** Returns the vendor's RAW per-job records, already trimmed to the
   *  fields this app uses, but NOT yet filtered to LinkedIn-only results —
   *  that filtering happens in filterToLinkedInResults() so it is testable
   *  independent of any specific vendor's raw response shape. */
  search(filters: LinkedInJobSearchFilters): Promise<RawVendorJob[]>;
}

/** A single job record as returned by the vendor, before LinkedIn-apply-
 *  option filtering. `applyOptions` mirrors SerpApi's Google Jobs API
 *  shape (an array of {title, link} per source the aggregation found —
 *  e.g. one entry each for LinkedIn, Indeed, the company's own site). Kept
 *  generic enough that swapping the vendor later only touches the adapter
 *  below, not the filtering/normalization logic that consumes this shape. */
export interface RawVendorJob {
  title: string;
  company: string;
  location?: string;
  description?: string;
  postedAtText?: string;
  applyOptions: Array<{ title?: string; link: string }>;
}

/** Real, live-measured (2026-09-15): SerpApi's google_jobs engine took
 *  11.3s for a direct, unmediated test call — a real backend-scraping
 *  latency on their end, not an edge case. The original 10s value was an
 *  untested guess; 25s gives real headroom above the observed number
 *  without being unboundedly generous. */
const SEARCH_TIMEOUT_MS = 25_000;

export class VendorNotConfiguredError extends Error {
  constructor() {
    super('linkedin_job_finder_vendor_not_configured');
    this.name = 'VendorNotConfiguredError';
  }
}

/**
 * Filters a vendor's raw results down to only those with a real
 * linkedin.com apply option — this is what keeps the feature genuinely
 * "LinkedIn Job Finder" rather than a generic aggregator (generic multi-
 * source aggregation from public feeds is already C1-C5's job, a
 * completely separate, frozen pipeline this feature must never touch or
 * duplicate). A job with no LinkedIn apply option is dropped entirely, not
 * shown with a substituted non-LinkedIn link.
 */
export function filterToLinkedInResults(raw: RawVendorJob[]): VendorJobResult[] {
  const results: VendorJobResult[] = [];
  for (const job of raw) {
    const linkedinOption = job.applyOptions.find((opt) => {
      try {
        return new URL(opt.link).hostname.toLowerCase().endsWith('linkedin.com');
      } catch {
        return false;
      }
    });
    if (!linkedinOption) continue;
    results.push({
      title: job.title,
      company: job.company,
      location: job.location,
      descriptionExcerpt: job.description ?? '',
      postedAtText: job.postedAtText,
      linkedinUrl: linkedinOption.link,
    });
  }
  return results;
}

/**
 * SerpApi's Google Jobs API — the specific vendor named in the audited
 * plan. `SERPAPI_KEY` is intentionally NOT provisioned as part of this
 * implementation pass (per the explicit authorization boundary: no vendor
 * account, no API key, no vendor spend until separately authorized). This
 * class is real, correct code — every call site downstream of it is fully
 * real-infra-testable via the injectable JobSearchVendor interface — but
 * it fails closed with VendorNotConfiguredError until a key is actually
 * provisioned, exactly mirroring generateApplicationKit()'s existing
 * `if (!apiKey) return fallback` pattern (src/lib/ai/materials.ts) for a
 * missing provider key.
 */
export class SerpApiGoogleJobsVendor implements JobSearchVendor {
  readonly name = 'serpapi_google_jobs';

  async search(filters: LinkedInJobSearchFilters): Promise<RawVendorJob[]> {
    const apiKey = process.env.SERPAPI_KEY;
    if (!apiKey) {
      throw new VendorNotConfiguredError();
    }

    const params = new URLSearchParams({
      engine: 'google_jobs',
      api_key: apiKey,
      q: buildQuery(filters),
    });
    if (filters.location) params.set('location', filters.location);
    if (filters.datePosted && filters.datePosted !== 'any') {
      params.set('chips', `date_posted:${mapDatePosted(filters.datePosted)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`SerpApi request failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        jobs_results?: Array<{
          title: string;
          company_name: string;
          location?: string;
          description?: string;
          detected_extensions?: { posted_at?: string };
          apply_options?: Array<{ title?: string; link: string }>;
        }>;
      };
      return (data.jobs_results ?? []).map((j) => ({
        title: j.title,
        company: j.company_name,
        location: j.location,
        description: j.description,
        postedAtText: j.detected_extensions?.posted_at,
        applyOptions: j.apply_options ?? [],
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildQuery(filters: LinkedInJobSearchFilters): string {
  const parts = [filters.keywords, filters.company, filters.jobType, filters.experienceLevel].filter(
    (p): p is string => Boolean(p && p.trim())
  );
  if (filters.remoteOnly) parts.push('remote');
  return parts.join(' ').trim() || 'remote jobs';
}

function mapDatePosted(value: Exclude<LinkedInJobSearchFilters['datePosted'], 'any' | undefined>): string {
  const map: Record<string, string> = {
    past24h: 'today',
    pastWeek: '3days', // SerpApi's google_jobs date_posted chip has no exact "week" value; 3days is the closest coarser-than-today option it exposes.
    pastMonth: 'month',
  };
  return map[value] ?? 'month';
}
