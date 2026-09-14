import { JobProvider, RawJobPayload } from './types';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createContentHash } from '@/lib/ingestion/pipeline';
import { waitForDomainSlot } from '@/lib/ingestion/domain-rate-limiter';
import { extractJobFromCareerPageText } from '@/lib/ai/career-page-extraction';
import { validateExtraction } from '@/lib/ingestion/extraction-validation';
import { recordEmployerFetchSuccess, recordEmployerFetchFailure } from '@/lib/ingestion/employer-registry';
import { checkRobotsPermission } from '@/lib/ingestion/robots-check';

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
 * Acquisition-validation Finding A (docs/c5-acquisition-validation-amendment.md
 * §1): schema.org's JobPosting.jobLocation.address permits EITHER a
 * PostalAddress object OR a plain string — real-world usage is inconsistent.
 * Confirmed live 2026-09-14 against Coinbase's and Okta's actual JobPosting
 * markup: both use the string form (`"address": "Remote - USA"`), which the
 * original object-only parser silently produced `locationString: ''` for.
 * Checked string form FIRST since it's the confirmed-real shape; falls back
 * to the object form, then the TELECOMMUTE/applicantLocationRequirements
 * signal, exactly as before.
 */
function extractLocationString(node: Record<string, unknown>): string {
  const jobLocation = node.jobLocation;
  if (jobLocation && typeof jobLocation === 'object') {
    const loc = jobLocation as Record<string, unknown>;
    const address = loc.address;
    if (typeof address === 'string' && address.trim()) {
      return address.trim();
    }
    if (address && typeof address === 'object') {
      const addr = address as Record<string, unknown>;
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (parts.length) return parts.join(', ');
    }
  }
  if (node.jobLocationType === 'TELECOMMUTE' || node.applicantLocationRequirements) return 'Remote';
  return '';
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
  const locationString = extractLocationString(node);

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

/**
 * Acquisition-validation Finding C (docs/c5-acquisition-validation-
 * amendment.md §3): a page carrying a JobPosting-typed JSON-LD node is a
 * single posting; anything else (Organization-typed, no LD-JSON at all —
 * confirmed live against Canonical's real /careers page, which is
 * Organization-typed) is an index page needing link discovery. Reuses the
 * exact JobPosting-detection helpers parseJsonLd() already has — no new
 * detection logic, just a different question asked of the same data.
 */
export type PageKind = 'single_posting' | 'index';

export function detectPageKind(html: string): PageKind {
  const blocks = extractJsonLdBlocks(html);
  return blocks.some((b) => findJobPostingNode(b) !== null) ? 'single_posting' : 'index';
}

const JOB_SHAPED_PATH = /job|career|position|vacanc/i;

/**
 * Same-origin-only link discovery — a hard safety boundary, not a tunable
 * option: a link to any origin other than baseUrl's is never followed, no
 * matter what the page contains. This is what keeps Finding C's discovery
 * step "still C5 career-page acquisition, not C6" — it only ever enumerates
 * pages within the ONE already-approved employer's own domain.
 *
 * Acceptance conditions (Deep, 2026-09-14, added on spec review):
 *   - Deduplicated before fetching: collected into a Set keyed on the
 *     resolved absolute URL, so the same href appearing multiple times on
 *     the page (nav + footer + body, or a #fragment-only variant of the
 *     same URL) yields exactly one entry.
 *   - Deterministic rejection before any network fetch or Gemini call: this
 *     function is pure and synchronous over already-fetched HTML text — it
 *     makes no network call itself, and the job-shaped-path regex + same-
 *     origin checks both run before a link is ever added to the result set.
 *     A non-job link is excluded at zero fetch cost and can never reach
 *     detectExtractionMethod()/Gemini at all; only links that survive this
 *     function are ever fetched by the caller.
 *
 * Job-shaped path heuristic matches the pattern already proven against a
 * real page during acquisition validation (Canonical's own category links:
 * /careers/engineering, /careers/sales, etc. all matched this shape live).
 * Capped at maxLinks — sized to the 5-10 employer cohort, not built for a
 * scale that doesn't exist yet, same reasoning as domain-rate-limiter.ts's
 * own header.
 */
export function discoverJobPostingLinks(html: string, baseUrl: string, maxLinks = 10): string[] {
  const base = new URL(baseUrl);
  const hrefs = Array.from(html.matchAll(/href="([^"]+)"/gi)).map((m) => m[1]);
  const resolved = new Set<string>();
  for (const href of hrefs) {
    if (resolved.size >= maxLinks) break;
    if (!JOB_SHAPED_PATH.test(href)) continue; // deterministic rejection, zero fetch cost
    try {
      const abs = new URL(href, base);
      if (abs.origin !== base.origin) continue; // same-domain only
      resolved.add(abs.toString());
    } catch {
      // malformed href, skip
    }
  }
  return Array.from(resolved);
}

/** Extracts a candidate from one already-fetched page, given its own URL —
 *  shared by both the single-posting root-page case and each discovered
 *  sub-link, so the json_ld/Gemini branch logic exists in exactly one
 *  place. Never itself fetches; the caller owns rate-limiting/robots-check/
 *  fetch for whichever URL this html came from. */
async function extractCandidateFromPage(
  html: string,
  url: string,
  company: string,
  sourceIdSuffix: string
): Promise<RawJobPayload | null> {
  const method = detectExtractionMethod(url, html);
  if (method === 'ats_redirect') return null;

  if (method === 'json_ld') {
    return parseJsonLd(html, url, company, sourceIdSuffix);
  }

  const text = extractMainText(html);
  const extraction = await extractJobFromCareerPageText(text, url);
  if (!extraction) return null;

  const validation = validateExtraction(extraction, text, {
    sourceId: `careerpage-${sourceIdSuffix}-${createContentHash(url)}`,
    source: 'careerpage',
    company,
    sourceUrl: url,
  });
  if (!validation.valid) {
    console.warn(`[CareerPageProvider] '${company}' (${url}) extraction failed validation: ${validation.reason}`);
    return null;
  }
  return validation.candidate;
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
        const rootMethod = detectExtractionMethod(employer.careerUrl, html);

        if (rootMethod === 'ats_redirect') {
          // This employer is misregistered — it should have been onboarded
          // through C3's ATS adapters instead. Log for manual correction,
          // never silently re-route through the ATS path from here.
          console.warn(`[CareerPageProvider] employer '${employer.canonicalName}' resolves to a known ATS host — misregistered, skipping. Needs manual correction to ats_provider.`);
          await recordEmployerFetchSuccess(employer.linkedSourceId, 0);
          continue;
        }

        // Acquisition-validation Finding C (docs/c5-acquisition-validation-
        // amendment.md §3): the registered career_url is realistically a
        // listing/index page far more often than a single posting —
        // confirmed live against 9 real companies. A single_posting page
        // (e.g. Coinbase's/Okta's own individual job pages) still goes
        // straight through extractCandidateFromPage() exactly as before;
        // an index page (e.g. Canonical's real /careers) is discovered into
        // same-domain, job-shaped candidate links first, each of which then
        // goes through the SAME extractCandidateFromPage() pipeline.
        const employerCandidates: RawJobPayload[] = [];

        if (detectPageKind(html) === 'single_posting') {
          const candidate = await extractCandidateFromPage(html, employer.careerUrl, employer.canonicalName, employer.id);
          if (candidate) employerCandidates.push(candidate);
        } else {
          const links = discoverJobPostingLinks(html, employer.careerUrl);
          for (const link of links) {
            // Per-URL robots-check: registration-time review only checked
            // the employer's root career_url — a discovered subpath can
            // legitimately carry its own Disallow rule (e.g.
            // /careers/internal/ blocked while /careers/public/ isn't).
            const robots = await checkRobotsPermission(link);
            if (!robots.allowed) continue;

            await waitForDomainSlot(employer.officialDomain);
            try {
              const subRes = await fetch(link, {
                headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
                signal: AbortSignal.timeout(15000),
              });
              if (!subRes.ok) continue; // one discovered link's failure never aborts the others
              const subHtml = await subRes.text();
              const candidate = await extractCandidateFromPage(subHtml, link, employer.canonicalName, employer.id);
              if (candidate) employerCandidates.push(candidate);
            } catch {
              continue;
            }
          }
        }

        results.push(...employerCandidates);
        await recordEmployerFetchSuccess(employer.linkedSourceId, employerCandidates.length);
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
