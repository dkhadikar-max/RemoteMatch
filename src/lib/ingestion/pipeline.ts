import { CanonicalOpportunity, RemoteType, EmploymentType } from '@/types/byn';
import { RawJobPayload, JobProvider } from '../providers/types';
import { sourceQualityFor } from './source-slug';
import { CuratedProvider } from '../providers/curated';
import { RemotiveProvider } from '../providers/remotive';
import { ArbeitnowProvider } from '../providers/arbeitnow';
import { JobicyProvider } from '../providers/jobicy';

// Simple deterministic hash helper
export function createContentHash(input: string): string {
  let hash = 0;
  const str = input.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

// Clean tracking queries from official URLs
export function cleanOfficialUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const paramsToDelete: string[] = [];
    parsed.searchParams.forEach((_, key) => {
      if (
        key.startsWith('utm_') ||
        key === 'ref' ||
        key === 'source' ||
        key === 'gh_src' ||
        key === 'lever-source'
      ) {
        paramsToDelete.push(key);
      }
    });
    paramsToDelete.forEach((k) => parsed.searchParams.delete(k));
    return parsed.toString();
  } catch {
    return rawUrl.split('?')[0];
  }
}

// Normalize company + title key
export function createNormalizedJobKey(company: string, title: string): string {
  const cleanComp = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanTitle = title
    .toLowerCase()
    .replace(/\bsenior\b|\blead\b|\bstaff\b|\bprincipal\b|\bjr\b|\bjunior\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return `${cleanComp}:${cleanTitle}`;
}

// Remote eligibility classifier
export function classifyRemoteEligibility(locationStr?: string, tags: string[] = []): {
  remoteType: RemoteType;
  eligibleCountries: string[];
} {
  const loc = (locationStr || '').trim().toLowerCase();
  const allText = `${loc} ${tags.join(' ')}`.toLowerCase();

  // 1. Explicit Worldwide
  if (
    /\b(worldwide|anywhere in the world|global remote|anywhere|100% remote worldwide)\b/i.test(loc) &&
    !/\b(us only|usa only|europe only|eu only)\b/i.test(allText)
  ) {
    return { remoteType: 'Worldwide', eligibleCountries: [] };
  }

  // 2. US / North America restrictions (including "Remote — US only", "Remote - US", "USA", "United States")
  if (
    /\b(us only|usa only|united states only|remote\s*[-—–]\s*us\b|remote\s*[-—–]\s*usa\b|usa|united states|north america)\b/i.test(allText)
  ) {
    return { remoteType: 'US', eligibleCountries: ['US', 'USA'] };
  }

  // 3. Europe / EU / UK restrictions (including "Remote in Europe", "Europe", "Remote (Europe)", "EU/EEA", "EMEA")
  if (
    /\b(europe only|eu only|uk only|remote\s*in\s*europe|remote\s*\(europe\)|remote\s*[-—–]\s*europe|europe|emea|eu\/eea|uk|germany|france|netherlands|ireland|spain)\b/i.test(allText)
  ) {
    return { remoteType: 'EU/EEA', eligibleCountries: ['EU', 'UK', 'EEA'] };
  }

  // 4. India restrictions
  if (
    /\b(india only|in only|remote\s*[-—–]\s*india|india|bangalore|delhi|mumbai)\b/i.test(allText)
  ) {
    return { remoteType: 'India', eligibleCountries: ['India'] };
  }

  // 5. Remote-friendly / Hybrid restrictions (Not fully autonomous worldwide remote)
  if (
    /\b(remote-friendly|remote friendly|hybrid|office-friendly|flexible location)\b/i.test(allText)
  ) {
    return { remoteType: 'Specific countries', eligibleCountries: [] };
  }

  // 6. Timezone restrictions
  if (
    allText.includes('timezone') ||
    allText.includes('pst') ||
    allText.includes('est') ||
    allText.includes('cet') ||
    allText.includes('hours overlap')
  ) {
    return { remoteType: 'Timezone restricted', eligibleCountries: [] };
  }

  // 7. Contractor only
  if (allText.includes('contractor only')) {
    return { remoteType: 'Contractor only', eligibleCountries: [] };
  }

  // Default to Worldwide if not restricted
  return { remoteType: 'Worldwide', eligibleCountries: [] };
}

export type ExplicitRemoteScope = 'explicit_worldwide' | 'explicit_restricted' | 'unknown';

/**
 * P1 (Job-Quality Intelligence) candidate observable attribute:
 * remote_scope_explicit. Strictly additive — classifyRemoteEligibility()
 * above is completely untouched, and its `remoteType`/`eligibleCountries`
 * output (used by matching/eligibility gating, a frozen contract) is not
 * read or altered here.
 *
 * classifyRemoteEligibility() defaults to 'Worldwide' when none of its
 * patterns match anything — silently turning "no location information
 * found" into a real-sounding value. That's correct for its own purpose
 * (matching needs some default), but wrong as an observable fact: this
 * function keeps "explicitly stated worldwide" and "nothing found"
 * distinct, because for P1's measurement purposes, `unknown` is missing
 * information, not evidence about the job — see the P1 scoping document.
 *
 * The pattern checks below intentionally duplicate
 * classifyRemoteEligibility()'s conditions rather than share code with
 * it, so a future change to one can never silently change the other's
 * behavior: observe more, change nothing.
 *
 * KNOWN TRADEOFF, ACCEPTED DELIBERATELY: this duplication creates pattern
 * drift risk — someone can edit one classifier's regexes without touching
 * the other's, and nothing here will catch it automatically. That risk is
 * accepted in exchange for the guarantee that matters more: neither
 * classifier can accidentally change the other's behavior as a side
 * effect of an edit (sharing the pattern logic could, if done carelessly,
 * alter the frozen eligibility semantics classifyRemoteEligibility()
 * feeds into). Do not refactor these into a shared implementation to
 * "fix" the duplication — that would reopen exactly the risk this
 * isolation exists to avoid. Any change to either classifier's patterns
 * requires a corresponding review of the other, and a re-run of both
 * test/gate2-live-supply.ts (frozen eligibility contract) and
 * test/p1-job-quality-suite.ts (this attribute).
 */
export function classifyExplicitRemoteScope(locationStr?: string, tags: string[] = []): ExplicitRemoteScope {
  const loc = (locationStr || '').trim().toLowerCase();
  const allText = `${loc} ${tags.join(' ')}`.toLowerCase();

  // Mirrors classifyRemoteEligibility() condition 1.
  if (
    /\b(worldwide|anywhere in the world|global remote|anywhere|100% remote worldwide)\b/i.test(loc) &&
    !/\b(us only|usa only|europe only|eu only)\b/i.test(allText)
  ) {
    return 'explicit_worldwide';
  }

  // Mirrors classifyRemoteEligibility() conditions 2-7 — any of these
  // matching means the listing said SOMETHING specific about scope, even
  // if it's not a hard geographic restriction (e.g. "hybrid",
  // "timezone", "contractor only"). Any explicit statement, restrictive
  // or not, counts as "explicit" here — this attribute measures whether
  // scope was stated at all, not what it said.
  const explicitPatterns = [
    /\b(us only|usa only|united states only|remote\s*[-—–]\s*us\b|remote\s*[-—–]\s*usa\b|usa|united states|north america)\b/i,
    /\b(europe only|eu only|uk only|remote\s*in\s*europe|remote\s*\(europe\)|remote\s*[-—–]\s*europe|europe|emea|eu\/eea|uk|germany|france|netherlands|ireland|spain)\b/i,
    /\b(india only|in only|remote\s*[-—–]\s*india|india|bangalore|delhi|mumbai)\b/i,
    /\b(remote-friendly|remote friendly|hybrid|office-friendly|flexible location)\b/i,
  ];
  if (explicitPatterns.some((re) => re.test(allText))) {
    return 'explicit_restricted';
  }
  if (
    allText.includes('timezone') ||
    allText.includes('pst') ||
    allText.includes('est') ||
    allText.includes('cet') ||
    allText.includes('hours overlap') ||
    allText.includes('contractor only')
  ) {
    return 'explicit_restricted';
  }

  // classifyRemoteEligibility() would default to 'Worldwide' here. This
  // function reports the honest state instead: nothing in the listing
  // text matched any known pattern.
  return 'unknown';
}

// Calculate Quality Score (0-100)
export function computeQualityScore(payload: RawJobPayload): number {
  let score = 55;

  if (payload.salaryString || (payload.salaryMin && payload.salaryMin > 0)) {
    score += 15;
  }
  if (payload.tags && payload.tags.length >= 3) {
    score += 10;
  }
  if (payload.description && payload.description.length > 300) {
    score += 10;
  }
  if (payload.companyLogo) {
    score += 5;
  }

  const ageDays = (Date.now() - new Date(payload.publicationDate).getTime()) / (1000 * 3600 * 24);
  if (ageDays <= 7) {
    score += 10;
  } else if (ageDays <= 14) {
    score += 5;
  } else if (ageDays > 35) {
    score -= 20; // Old job penalty
  }

  return Math.min(Math.max(score, 20), 99);
}

/**
 * Resolve a job's pay period WITHOUT guessing. Order:
 *   1. an explicit period the provider set (RawJobPayload.salaryPeriod)
 *   2. an unambiguous marker in the free-text salaryString
 *   3. 'unknown' — never assume 'yearly' from a bare number
 * The result flows to schema.org JobPosting: 'unknown' means unitText is
 * omitted, not defaulted (see buildJobPostingSchema / the Phase A blocker fix).
 */
export function resolveSalaryPeriod(raw: RawJobPayload): 'hourly' | 'monthly' | 'yearly' | 'unknown' {
  if (raw.salaryPeriod && raw.salaryPeriod !== 'unknown') return raw.salaryPeriod;
  const s = (raw.salaryString || '').toLowerCase();
  if (!s) return 'unknown';
  if (/(per|\/|\ba[n]?)\s*(hour|hr\b)|hourly/.test(s)) return 'hourly';
  if (/(per|\/|\ba)\s*(month|mo\b)|monthly|p\.?m\.?\b/.test(s)) return 'monthly';
  if (/(per|\/|\ba)\s*(year|yr\b|annum)|annual(ly)?|p\.?a\.?\b/.test(s)) return 'yearly';
  return 'unknown';
}

// Normalize RawJobPayload to CanonicalOpportunity
export function normalizeOpportunity(raw: RawJobPayload): CanonicalOpportunity {
  const cleanUrl = cleanOfficialUrl(raw.officialUrl || raw.sourceUrl || '');
  const urlHash = createContentHash(cleanUrl);
  const contentHash = createContentHash(`${raw.company}:${raw.title}:${raw.description.slice(0, 300)}`);
  const { remoteType, eligibleCountries } = classifyRemoteEligibility(raw.locationString, raw.tags);
  // P1 candidate attribute — computed alongside remoteType but does not
  // feed into it or read its output; see classifyExplicitRemoteScope()'s
  // own header for why this must stay a separate computation.
  const explicitRemoteScope = classifyExplicitRemoteScope(raw.locationString, raw.tags);

  const empType: EmploymentType =
    raw.jobType.toLowerCase().includes('contract') || raw.title.toLowerCase().includes('contract')
      ? 'Contract'
      : raw.jobType.toLowerCase().includes('freelance') || raw.title.toLowerCase().includes('freelance')
      ? 'Freelance'
      : raw.jobType.toLowerCase().includes('part')
      ? 'Part-time'
      : 'Full-time';

  const ageDays = (Date.now() - new Date(raw.publicationDate).getTime()) / (1000 * 3600 * 24);
  const isStale = ageDays > 60;
  const isWeakDesc = (raw.description || '').trim().length < 100;
  const status = isStale ? 'expired' : isWeakDesc ? 'draft' : 'active';

  return {
    id: `opp-${raw.source}-${raw.sourceId}`,
    type: empType === 'Freelance' ? 'freelance' : empType === 'Contract' ? 'contract' : 'job',
    title: raw.title.trim(),
    company: raw.company.trim(),
    companyLogo: raw.companyLogo,
    description: raw.description.trim(),
    source: raw.source,
    sourceId: raw.sourceId,
    sourceUrl: raw.sourceUrl,
    officialUrl: cleanUrl,
    canonicalUrlHash: urlHash,
    contentHash: contentHash,
    employmentType: empType,
    remoteType: remoteType,
    eligibleCountries: eligibleCountries,
    excludedCountries: [],
    timezoneRequirements: [],
    salaryMin: raw.salaryMin,
    salaryMax: raw.salaryMax,
    salaryCurrency: raw.salaryCurrency || 'USD',
    salaryPeriod: resolveSalaryPeriod(raw),
    requiredSkills: raw.tags || [],
    preferredSkills: [],
    experienceRequirement: raw.experienceLevel || '2-3',
    qualityScore: computeQualityScore(raw),
    // Provenance hint for the 4 built-in sources; `undefined` for any source
    // the discovery registry adds later — we make no quality claim about a
    // source we have no outcome evidence for (gate C1, decision Q4). The
    // column is nullable and catalog-sync writes `?? null`.
    sourceQuality: sourceQualityFor(raw.source),
    descriptionCompleteness: (raw.description || '').length > 800 ? 'high' : (raw.description || '').length > 300 ? 'medium' : 'low',
    salaryQuality: raw.salaryMin && raw.salaryMin > 0 ? 'verified' : raw.salaryString ? 'estimated' : 'unspecified',
    remotePolicyConfidence: remoteType === 'Worldwide' || eligibleCountries.length > 0 ? 'high' : 'medium',
    explicitRemoteScope,
    status: status,
    isActive: status === 'active',
    postedAt: raw.publicationDate,
    lastVerifiedAt: new Date().toISOString(),
  };
}

// Layered Deduplication Filter
export function deduplicateOpportunities(
  opportunities: CanonicalOpportunity[]
): CanonicalOpportunity[] {
  const seenSourceKeys = new Set<string>();
  const seenUrlHashes = new Set<string>();
  const seenCompanyTitleKeys = new Set<string>();
  const seenContentHashes = new Set<string>();

  const uniqueOpportunities: CanonicalOpportunity[] = [];

  for (const opp of opportunities) {
    const sourceKey = `${opp.source}:${opp.sourceId}`;
    const compTitleKey = createNormalizedJobKey(opp.company, opp.title);

    // Layer 1: source + source_id
    if (seenSourceKeys.has(sourceKey)) continue;

    // Layer 2: canonical official URL
    if (seenUrlHashes.has(opp.canonicalUrlHash)) continue;

    // Layer 3: normalized title + company
    if (seenCompanyTitleKeys.has(compTitleKey)) continue;

    // Layer 4: content fingerprint
    if (seenContentHashes.has(opp.contentHash)) continue;

    // Register all fingerprints
    seenSourceKeys.add(sourceKey);
    seenUrlHashes.add(opp.canonicalUrlHash);
    seenCompanyTitleKeys.add(compTitleKey);
    seenContentHashes.add(opp.contentHash);

    uniqueOpportunities.push(opp);
  }

  return uniqueOpportunities;
}

// Ingestion Manager
export class IngestionManager {
  private providers: JobProvider[];

  constructor() {
    this.providers = [
      new CuratedProvider(),
      new RemotiveProvider(),
      new ArbeitnowProvider(),
      new JobicyProvider(),
    ];
  }

  async runIngestion(): Promise<{ totalFetched: number; totalUnique: number; opportunities: CanonicalOpportunity[] }> {
    const allRaw: RawJobPayload[] = [];

    // Run providers in parallel
    const results = await Promise.allSettled(
      this.providers.map(async (provider) => {
        try {
          return await provider.fetchJobs();
        } catch (err) {
          console.error(`Provider ${provider.name} failed:`, err);
          return [];
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allRaw.push(...result.value);
      }
    }

    // Normalize
    const normalized = allRaw.map(normalizeOpportunity);

    // Filter out low quality or expired
    const active = normalized.filter((o) => o.status === 'active' && o.title && o.company);

    // Deduplicate
    const unique = deduplicateOpportunities(active);

    return {
      totalFetched: allRaw.length,
      totalUnique: unique.length,
      opportunities: unique,
    };
  }

  // Audit link freshness and reachability
  async auditLinkFreshness(
    opportunities: CanonicalOpportunity[]
  ): Promise<{ active: CanonicalOpportunity[]; stale: CanonicalOpportunity[] }> {
    const active: CanonicalOpportunity[] = [];
    const stale: CanonicalOpportunity[] = [];

    for (const opp of opportunities) {
      // Prioritize checking older jobs (> 30 days) or jobs with non-standard status
      const ageDays = (Date.now() - new Date(opp.postedAt).getTime()) / (1000 * 3600 * 24);
      if (ageDays > 30) {
        const check = await verifyLinkFreshness(opp.officialUrl);
        if (!check.reachable) {
          opp.status = 'expired';
          opp.isActive = false;
          stale.push(opp);
          continue;
        }
      }
      opp.isActive = true;
      active.push(opp);
    }

    return { active, stale };
  }
}

// Reachability & Freshness checker for official opportunity links
export async function verifyLinkFreshness(
  url: string,
  timeoutMs = 4000
): Promise<{ reachable: boolean; statusCode?: number }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'RemoteMatchBot/1.0 (Job Freshness Verification; +https://remotematch.com)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Dead link indicators: 404 Not Found, 410 Gone
    if (res.status === 404 || res.status === 410) {
      return { reachable: false, statusCode: res.status };
    }

    // 200-399 and 403 (many ATS platforms block HEAD but page exists) are considered reachable
    return { reachable: true, statusCode: res.status };
  } catch {
    // Network/timeout error during local test or dev machine: treat as reachable by default to prevent false drops
    return { reachable: true };
  }
}

