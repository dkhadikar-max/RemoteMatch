import { AtsProbeResult } from '@/types/discovery';

const ATS_PROBE_TIMEOUT_MS = 5000;

/**
 * Extracts candidate ATS board slugs from company name and domain.
 * E.g. 'GitLab Inc.' + 'gitlab.com' -> ['gitlab', 'gitlabinc']
 */
export function generateCandidateBoardSlugs(companyName: string, domain?: string): string[] {
  const slugs = new Set<string>();

  const nameSlug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
  if (nameSlug && nameSlug.length >= 2) {
    slugs.add(nameSlug);
  }

  const nameHyphen = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
  if (nameHyphen && nameHyphen.length >= 2) {
    slugs.add(nameHyphen);
  }

  if (domain) {
    const domainPrefix = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (domainPrefix && domainPrefix.length >= 2) {
      slugs.add(domainPrefix);
    }
  }

  // Common suffix stripping (inc, tech, io, hq, co)
  for (const slug of Array.from(slugs)) {
    const stripped = slug.replace(/(inc|tech|corp|llc|io|hq|co|app|software)$/g, '');
    if (stripped && stripped.length >= 3) {
      slugs.add(stripped);
    }
  }

  return Array.from(slugs).slice(0, 4);
}

/**
 * Probes Greenhouse public boards API for a token.
 */
async function probeGreenhouse(token: string): Promise<AtsProbeResult | null> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATS_PROBE_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Company Discovery; +https://remotematch.com)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status !== 200) return null;

    const data = await res.json();
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    if (jobs.length === 0) return null;

    // Check remote jobs count and snippet
    const remoteJobs = jobs.filter((j: { title?: string; location?: { name?: string } }) => {
      const text = `${j.title || ''} ${j.location?.name || ''}`.toLowerCase();
      return text.includes('remote') || text.includes('anywhere') || text.includes('distributed');
    });

    const snippet = remoteJobs.length > 0
      ? `${remoteJobs[0].title} (${remoteJobs[0].location?.name || 'Remote'})`
      : undefined;

    return {
      detected: true,
      platform: 'greenhouse',
      boardSlug: token,
      endpointUrl: url,
      sampleJobsCount: jobs.length,
      remoteJobsCount: remoteJobs.length,
      remoteEvidenceSnippet: snippet,
    };
  } catch {
    return null;
  }
}

/**
 * Probes Lever public postings API for a token.
 */
async function probeLever(token: string): Promise<AtsProbeResult | null> {
  try {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATS_PROBE_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Company Discovery; +https://remotematch.com)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status !== 200) return null;

    const jobs = await res.json();
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const remoteJobs = jobs.filter((j: { text?: string; categories?: { location?: string; workplaceType?: string } }) => {
      const text = `${j.text || ''} ${j.categories?.location || ''} ${j.categories?.workplaceType || ''}`.toLowerCase();
      return text.includes('remote') || text.includes('anywhere') || text.includes('distributed');
    });

    const snippet = remoteJobs.length > 0
      ? `${remoteJobs[0].text} (${remoteJobs[0].categories?.location || remoteJobs[0].categories?.workplaceType || 'Remote'})`
      : undefined;

    return {
      detected: true,
      platform: 'lever',
      boardSlug: token,
      endpointUrl: url,
      sampleJobsCount: jobs.length,
      remoteJobsCount: remoteJobs.length,
      remoteEvidenceSnippet: snippet,
    };
  } catch {
    return null;
  }
}

/**
 * Probes Ashby public job-board API for a token.
 */
async function probeAshby(token: string): Promise<AtsProbeResult | null> {
  try {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATS_PROBE_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Company Discovery; +https://remotematch.com)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status !== 200) return null;

    const data = await res.json();
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    if (jobs.length === 0) return null;

    const remoteJobs = jobs.filter((j: { title?: string; location?: string; isRemote?: boolean }) => {
      if (j.isRemote === true) return true;
      const text = `${j.title || ''} ${j.location || ''}`.toLowerCase();
      return text.includes('remote') || text.includes('anywhere') || text.includes('distributed');
    });

    const snippet = remoteJobs.length > 0
      ? `${remoteJobs[0].title} (${remoteJobs[0].location || 'Remote'})`
      : undefined;

    return {
      detected: true,
      platform: 'ashby',
      boardSlug: token,
      endpointUrl: url,
      sampleJobsCount: jobs.length,
      remoteJobsCount: remoteJobs.length,
      remoteEvidenceSnippet: snippet,
    };
  } catch {
    return null;
  }
}

/**
 * Probes all supported C3 ATS platforms for candidate board slugs.
 * Exits immediately on the first valid match.
 */
export async function detectAtsEndpoint(companyName: string, domain?: string): Promise<AtsProbeResult> {
  const candidateSlugs = generateCandidateBoardSlugs(companyName, domain);

  for (const slug of candidateSlugs) {
    // 1. Probe Greenhouse
    const gh = await probeGreenhouse(slug);
    if (gh && gh.detected) return gh;

    // 2. Probe Lever
    const lev = await probeLever(slug);
    if (lev && lev.detected) return lev;

    // 3. Probe Ashby
    const ash = await probeAshby(slug);
    if (ash && ash.detected) return ash;
  }

  return { detected: false };
}
