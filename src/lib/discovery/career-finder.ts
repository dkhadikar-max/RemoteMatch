import { checkRobotsPermission } from '@/lib/ingestion/robots-check';
import { detectExtractionMethod } from '@/lib/providers/career-page';
import { CareerSurfaceResult, AtsProbeResult } from '@/types/discovery';
import { isSsrfSafeHostname } from './domain-resolver';

const CAREER_PATH_CANDIDATES = [
  '/careers',
  '/jobs',
  '/about/careers',
  '/join-us',
  '/work-with-us',
  '/careers/jobs',
  '/company/careers',
];

const REMOTE_EVIDENCE_REGEX = /\b(remote|anywhere|distributed|work from home|telecommute|work anywhere|fully remote|global remote|work from anywhere)\b/i;

const ATS_LINK_REGEX = /href=["'](https?:\/\/(boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\/([a-zA-Z0-9_-]+)[^"']*)["']/i;

/**
 * Finds the official career surface of a company given its root website URL.
 */
export async function findCareerSurface(officialUrl: string, companyName: string): Promise<CareerSurfaceResult> {
  try {
    const base = new URL(officialUrl);
    const origin = base.origin;

    // 1. Fetch homepage to inspect navigation links and ATS redirects
    const ssrfSafe = await isSsrfSafeHostname(base.hostname);
    if (!ssrfSafe) {
      return { found: false, rejectionReason: 'ssrf_unsafe_host' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(origin, {
      headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Career Discovery; +https://remotematch.com)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { found: false, rejectionReason: `homepage_status_${res.status}` };
    }

    const html = await res.text();

    // 2. Check if homepage links directly to an ATS board (Greenhouse/Lever/Ashby)
    const atsMatch = html.match(ATS_LINK_REGEX);
    if (atsMatch) {
      const fullAtsUrl = atsMatch[1];
      const host = atsMatch[2];
      const token = atsMatch[3];
      const platform = host.includes('greenhouse')
        ? 'greenhouse'
        : host.includes('lever')
        ? 'lever'
        : 'ashby';

      return {
        found: true,
        careerUrl: fullAtsUrl,
        method: 'ats_redirect',
        atsResult: {
          detected: true,
          platform,
          boardSlug: token,
          endpointUrl: fullAtsUrl,
        },
      };
    }

    // 3. Scan homepage for internal career links
    const internalCareerMatch = html.match(/href=["'](\/(careers|jobs|join-us|about\/careers|work-with-us)[^"']*)["']/i);
    let targetCareerUrl: string | null = null;
    let method: 'canonical_path' | 'homepage_link' = 'homepage_link';

    if (internalCareerMatch) {
      targetCareerUrl = new URL(internalCareerMatch[1], origin).toString();
    } else {
      // 4. Try standard candidate paths
      for (const path of CAREER_PATH_CANDIDATES) {
        const candidateUrl = `${origin}${path}`;
        try {
          const probeController = new AbortController();
          const probeTimeout = setTimeout(() => probeController.abort(), 3500);
          const probeRes = await fetch(candidateUrl, {
            method: 'HEAD',
            headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Career Discovery; +https://remotematch.com)' },
            signal: probeController.signal,
          });
          clearTimeout(probeTimeout);

          if (probeRes.ok) {
            targetCareerUrl = candidateUrl;
            method = 'canonical_path';
            break;
          }
        } catch {
          // continue checking
        }
      }
    }

    if (!targetCareerUrl) {
      return { found: false, rejectionReason: 'no_career_page_detected' };
    }

    // 5. Check robots.txt permission on career URL
    const robots = await checkRobotsPermission(targetCareerUrl);
    if (!robots.allowed) {
      return {
        found: false,
        careerUrl: targetCareerUrl,
        robotsAllowed: false,
        rejectionReason: 'robots_disallowed',
      };
    }

    // 6. Fetch the career page to evaluate remote evidence and JSON-LD
    const careerController = new AbortController();
    const careerTimeout = setTimeout(() => careerController.abort(), 6000);
    const careerRes = await fetch(targetCareerUrl, {
      headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Career Discovery; +https://remotematch.com)' },
      signal: careerController.signal,
    });
    clearTimeout(careerTimeout);

    if (!careerRes.ok) {
      return {
        found: false,
        careerUrl: targetCareerUrl,
        rejectionReason: `career_page_status_${careerRes.status}`,
      };
    }

    const careerHtml = await careerRes.text();
    const extractionMethod = detectExtractionMethod(targetCareerUrl, careerHtml);
    const hasJsonLd = extractionMethod === 'json_ld';

    // 7. Remote evidence check
    const remoteMatch = careerHtml.match(REMOTE_EVIDENCE_REGEX);
    let remoteEvidenceSnippet: string | undefined;
    if (remoteMatch) {
      const idx = remoteMatch.index || 0;
      const start = Math.max(0, idx - 40);
      const end = Math.min(careerHtml.length, idx + 60);
      remoteEvidenceSnippet = careerHtml.slice(start, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    return {
      found: true,
      careerUrl: targetCareerUrl,
      method,
      hasJsonLd,
      robotsAllowed: true,
      remoteEvidenceSnippet,
    };
  } catch (err) {
    return { found: false, rejectionReason: `discovery_error: ${(err as Error).message}` };
  }
}
