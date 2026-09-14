import { JobProvider, RawJobPayload } from './types';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createContentHash } from '@/lib/ingestion/pipeline';
import { waitForDomainSlot } from '@/lib/ingestion/domain-rate-limiter';
import { extractJobFromCareerPageText } from '@/lib/ai/career-page-extraction';
import { validateExtraction } from '@/lib/ingestion/extraction-validation';
import { recordEmployerFetchSuccess, recordEmployerFetchFailure } from '@/lib/ingestion/employer-registry';

/**
 * Career-page ATS-less adapter (Supply Discovery gate C5, docs/c5-implementation-plan.md §7).
 *
 * Deliberately does NOT import anything from employer-registry.ts's query
 * functions beyond the two generic, ats-agnostic bookkeeping calls
 * (recordEmployerFetchSuccess/Failure — already keyed on `linkedSourceId`,
 * not on any ATS-specific shape). Per §0, this module owns its own employer
 * query rather than adding an ats_provider-agnostic branch to C3's frozen
 * employer-registry.ts — the freeze is respected structurally, not just by
 * not editing files, but by not growing them either.
 *
 * `sourceKey`/`source` uses the slug `careerpage`, not the spec text's
 * literal `career_page` — `supply_platforms.slug` is CHECK-constrained to
 * `^[a-z0-9]+$` (migration 012, part of the frozen C1 foundation); an
 * underscore is not a legal slug. This is a mechanical naming correction to
 * fit the existing, unmodifiable constraint, not a design change — flagged
 * here explicitly rather than silently.
 */

const ATS_REDIRECT_HOSTS = ['boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com'];

export type ExtractionMethod = 'json_ld' | 'ats_redirect' | 'gemini';

/** Deterministic classification — never itself a source of truth about job
 *  content, only about WHICH extraction path to use. */
export function detectExtractionMethod(url: string, html: string): ExtractionMethod {
  try {
    const parsed = new URL(url);
    if (ATS_REDIRECT_HOSTS.some((host) => parsed.hostname.endsWith(host))) {
      return 'ats_redirect';
    }
  } catch {
    // malformed URL — fall through to content-based detection
  }
  if (/<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(html)) {
    // Confirm it actually contains a JobPosting block, not just any JSON-LD
    // (e.g. Organization/BreadcrumbList markup unrelated to the posting).
    const blocks = extractJsonLdBlocks(html);
    if (blocks.some((b) => jsonLdIsJobPosting(b))) return 'json_ld';
  }
  return 'gemini';
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // malformed JSON-LD block — skip, not fatal to the whole page
    }
  }
  return blocks;
}

function jsonLdIsJobPosting(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const obj = block as Record<string, unknown>;
  if (obj['@type'] === 'JobPosting') return true;
  if (Array.isArray(obj['@graph'])) {
    return (obj['@graph'] as unknown[]).some((n) => n && typeof n === 'object' && (n as Record<string, unknown>)['@type'] === 'JobPosting');
  }
  return false;
}

function findJobPostingNode(block: unknown): Record<string, unknown> | null {
  if (!block || typeof block !== 'object') return null;
  const obj = block as Record<string, unknown>;
  if (obj['@type'] === 'JobPosting') return obj;
  if (Array.isArray(obj['@graph'])) {
    const found = (obj['@graph'] as unknown[]).find(
      (n) => n && typeof n === 'object' && (n as Record<string, unknown>)['@type'] === 'JobPosting'
    );
    return (found as Record<string, unknown>) ?? null;
  }
  return null;
}

/**
 * Deterministic — the site itself explicitly published this as structured
 * schema.org/JobPosting data, distinct from free text an LLM must interpret.
 * No evidence check needed (per §7 pseudocode, verbatim): there is nothing
 * to validate against because there was no inference step to begin with.
 */
export function parseJsonLd(html: string, url: string, company: string, sourceIdSuffix: string): RawJobPayload | null {
  const blocks = extractJsonLdBlocks(html);
  let node: Record<string, unknown> | null = null;
  for (const block of blocks) {
    node = findJobPostingNode(block);
    if (node) break;
  }
  if (!node) return null;

  const title = typeof node.title === 'string' ? node.title : null;
  if (!title) return null;

  const description = typeof node.description === 'string' ? stripHtmlTags(node.description) : '';
  const datePosted = typeof node.datePosted === 'string' ? node.datePosted : '';
  const employmentType = typeof node.employmentType === 'string' ? node.employmentType : 'Full-time';

  let locationString = '';
  const jobLocation = node.jobLocation;
  if (jobLocation && typeof jobLocation === 'object') {
    const loc = jobLocation as Record<string, unknown>;
    const address = loc.address as Record<string, unknown> | undefined;
    const parts = [address?.addressLocality, address?.addressRegion, address?.addressCountry]
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    locationString = parts.join(', ');
  } else if (node.jobLocationType === 'TELECOMMUTE' || node.applicantLocationRequirements) {
    locationString = 'Remote';
  }

  return {
    sourceId: `careerpage-${sourceIdSuffix}-${createContentHash(url)}`,
    source: 'careerpage',
    title,
    company,
    description: description.slice(0, 1500),
    sourceUrl: url,
    officialUrl: url,
    jobType: employmentType,
    locationString,
    tags: [],
    publicationDate: datePosted,
  };
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

/** Strips boilerplate (nav/header/footer/script/style) around a page to
 *  approximate "just the posting section" for the Gemini call — a simple
 *  heuristic, not a real content-extraction library; acceptable because the
 *  evidence check downstream still rejects any field Gemini can't source
 *  back to the (still-present) actual posting text within the truncation. */
function extractMainText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');
  return stripHtmlTags(withoutNoise);
}

interface CareerPageEmployer {
  id: string;
  canonicalName: string;
  careerUrl: string;
  officialDomain: string;
  linkedSourceId: string | null;
}

/** Self-contained query — deliberately not added to employer-registry.ts.
 *  ats_provider IS NULL is exactly how §3 defines a career-page employer. */
async function getApprovedCareerPageEmployers(): Promise<CareerPageEmployer[]> {
  const admin = getSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from('allowlist_employers')
    .select('id, canonical_name, career_url, official_domain, linked_source_id')
    .is('ats_provider', null)
    .eq('review_status', 'approved');
  if (error || !data) return [];
  return data.map((row) => ({
    id: row.id,
    canonicalName: row.canonical_name,
    careerUrl: row.career_url,
    officialDomain: row.official_domain,
    linkedSourceId: row.linked_source_id,
  }));
}

export class CareerPageProvider implements JobProvider {
  readonly name = 'CareerPage';
  readonly sourceKey = 'careerpage';

  async fetchJobs(): Promise<RawJobPayload[]> {
    const employers = await getApprovedCareerPageEmployers();
    const results: RawJobPayload[] = [];

    for (const employer of employers) {
      try {
        await waitForDomainSlot(employer.officialDomain);

        const res = await fetch(employer.careerUrl, {
          headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
          signal: AbortSignal.timeout(15000),
        });

        if (res.status === 403 || res.status === 429) {
          // §4c: a blocked scraper is a SOURCE FAILURE, never a dead-link
          // signal — never interpreted downstream as "job removed".
          await recordEmployerFetchFailure(employer.linkedSourceId);
          console.warn(`[CareerPageProvider] employer '${employer.canonicalName}' blocked (${res.status}) — recorded as source failure, not dead-link.`);
          continue;
        }
        if (!res.ok) {
          await recordEmployerFetchFailure(employer.linkedSourceId);
          console.error(`[CareerPageProvider] employer '${employer.canonicalName}' returned ${res.status}`);
          continue;
        }

        const html = await res.text();
        const method = detectExtractionMethod(employer.careerUrl, html);

        if (method === 'ats_redirect') {
          // This employer is misregistered — it should have been onboarded
          // through C3's ATS adapters instead. Log for manual correction,
          // never silently re-route through the ATS path from here.
          console.warn(`[CareerPageProvider] employer '${employer.canonicalName}' resolves to a known ATS host — misregistered, skipping. Needs manual correction to ats_provider.`);
          await recordEmployerFetchSuccess(employer.linkedSourceId, 0);
          continue;
        }

        let candidate: RawJobPayload | null = null;

        if (method === 'json_ld') {
          candidate = parseJsonLd(html, employer.careerUrl, employer.canonicalName, employer.id);
        } else {
          const text = extractMainText(html);
          const extraction = await extractJobFromCareerPageText(text, employer.careerUrl);
          if (extraction) {
            const validation = validateExtraction(extraction, text, {
              sourceId: `careerpage-${employer.id}-${createContentHash(employer.careerUrl)}`,
              source: 'careerpage',
              company: employer.canonicalName,
              sourceUrl: employer.careerUrl,
            });
            if (validation.valid) {
              candidate = validation.candidate;
            } else {
              console.warn(`[CareerPageProvider] employer '${employer.canonicalName}' extraction failed validation: ${validation.reason}`);
            }
          }
        }

        if (candidate) results.push(candidate);
        await recordEmployerFetchSuccess(employer.linkedSourceId, candidate ? 1 : 0);
      } catch (err) {
        // Per-employer isolation, matching C3's pattern exactly (§7): one
        // employer's failure never aborts the run or the other employers.
        await recordEmployerFetchFailure(employer.linkedSourceId);
        console.error(`[CareerPageProvider] employer '${employer.canonicalName}' fetch failed:`, err);
      }
    }

    return results;
  }
}
