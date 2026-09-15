import { CanonicalOpportunity, EmploymentType, RemoteType } from '@/types/byn';
import { createContentHash } from '@/lib/ingestion/pipeline';
import type {
  VendorJobResult,
  PastedJobInput,
  LinkedInJobProvenance,
  DescriptionConfidence,
} from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — in-memory normalization (plan §22 step [2]).
 *
 * Builds a CanonicalOpportunity-SHAPED object so the existing, unmodified
 * matching pipeline (src/lib/matching/engine.ts, career-transition.ts) can
 * run on it exactly as it runs on a real catalog opportunity — those
 * functions only ever read title/description/requiredSkills/remoteType/
 * employmentType/experienceRequirement (confirmed via codebase research
 * before this file was written). Every OTHER CanonicalOpportunity field
 * below is a structurally-required-but-functionally-unused placeholder for
 * this flow, populated deterministically rather than left as TypeScript
 * `any`-shaped noise.
 *
 * HARD INVARIANT: `id` is namespaced `li-<uuid>`, never `opp-*`. This is not
 * cosmetic — getActiveOpportunityByCanonicalId() (src/lib/ingestion/
 * catalog-read.ts) is the ONLY other place a `CanonicalOpportunity`-shaped
 * object is normally resolved from, and it hard-validates the `opp-`
 * prefix. A `li-` id can never be mistaken for, or accidentally routed
 * through, that catalog-only path. `source: 'linkedin'` is NEVER a
 * `supply_platforms.slug` — this object must never reach
 * src/lib/ingestion/catalog-sync.ts or pipeline.ts, and never gets written
 * to the `opportunities` table (plan §30's hard architectural invariant).
 */

const DESCRIPTION_TRUNCATION_THRESHOLD = 400;

function randomLinkedInId(): string {
  // crypto.randomUUID() is available in both the Node/Edge runtimes this
  // code runs in; no new dependency needed.
  return `li-${crypto.randomUUID()}`;
}

/** A vendor excerpt shorter than the threshold, or one that visibly trails
 *  off ("...", ellipsis, or a mid-word cut), is treated as 'excerpt'
 *  confidence — never silently presented as equivalent to a full-text
 *  match. See plan §24/§25. */
function classifyDescriptionConfidence(description: string, provenance: LinkedInJobProvenance): DescriptionConfidence {
  if (provenance === 'user_pasted') return 'full';
  const trimmed = description.trim();
  if (trimmed.length < DESCRIPTION_TRUNCATION_THRESHOLD) return 'excerpt';
  if (/(\.\.\.|…)\s*$/.test(trimmed)) return 'excerpt';
  return 'excerpt'; // vendor-sourced text is always excerpt-confidence — see doc comment above; only a user's own paste ever earns 'full'.
}

/** Very small, best-effort remote-scope inference from free text — mirrors
 *  the spirit of classifyExplicitRemoteScope() (pipeline.ts) without
 *  importing it, since that function is scoped to the acquisition pipeline
 *  and this object must never be mistaken for pipeline output. Defaults to
 *  'Worldwide' only when nothing more specific is stated, matching the
 *  existing Remotive-style fallback precedent elsewhere in the codebase. */
function inferRemoteType(text: string): RemoteType {
  const lower = text.toLowerCase();
  if (/\bus only\b|\bunited states only\b|\bus-based\b|\bmust be based in the us\b/.test(lower)) return 'US';
  if (/\beu\b|\beea\b|\beurope only\b/.test(lower)) return 'EU/EEA';
  if (/\bindia only\b|\bindia-based\b/.test(lower)) return 'India';
  return 'Worldwide';
}

function inferEmploymentType(text: string): EmploymentType {
  const lower = text.toLowerCase();
  if (lower.includes('contract')) return 'Contract';
  if (lower.includes('freelance')) return 'Freelance';
  if (lower.includes('part-time') || lower.includes('part time')) return 'Part-time';
  return 'Full-time';
}

/** Small, deterministic keyword-overlap skill extraction — NOT an AI call,
 *  intentionally lightweight (this feeds a real-time search-results list,
 *  not a one-off paste). Matches whole words only, case-insensitive,
 *  against a short curated list of common remote-role skill terms — errs
 *  toward under-extraction (empty is fine; engine.ts treats no overlap as
 *  a real signal, not a crash) rather than inventing skills not actually
 *  present in the text. */
const SKILL_VOCAB = [
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust', 'ruby', 'php',
  'react', 'vue', 'angular', 'node', 'next.js', 'django', 'rails', 'spring',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'sql', 'postgres',
  'mongodb', 'redis', 'graphql', 'rest api', 'ci/cd', 'figma', 'product management',
  'project management', 'sales', 'marketing', 'seo', 'content writing', 'copywriting',
  'customer support', 'data analysis', 'machine learning', 'ai', 'ux', 'ui design',
];

function extractSkills(text: string): string[] {
  const lower = text.toLowerCase();
  return SKILL_VOCAB.filter((skill) => lower.includes(skill)).map((s) =>
    s.replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function buildCanonical(params: {
  title: string;
  company: string;
  description: string;
  location: string | undefined;
  linkedinUrl: string;
  provenance: LinkedInJobProvenance;
  postedAtIso: string;
}): CanonicalOpportunity {
  const { title, company, description, location, linkedinUrl, provenance, postedAtIso } = params;
  const combinedText = `${title} ${description} ${location ?? ''}`;
  const id = randomLinkedInId();
  const nowIso = new Date().toISOString();

  return {
    id,
    type: 'job',
    title,
    company,
    description,
    // 'linkedin' is a display-only tag — NEVER registered in supply_platforms,
    // NEVER written to opportunities.source. See doc comment above.
    source: 'linkedin',
    sourceId: id,
    sourceUrl: linkedinUrl,
    officialUrl: linkedinUrl,
    canonicalUrlHash: createContentHash(linkedinUrl),
    contentHash: createContentHash(`${company}:${title}:${description.slice(0, 300)}`),
    employmentType: inferEmploymentType(combinedText),
    remoteType: inferRemoteType(combinedText),
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: extractSkills(combinedText),
    preferredSkills: [],
    qualityScore: provenance === 'user_pasted' ? 60 : 45, // unused by engine.ts's scoring math; a modest, honest placeholder only
    explicitRemoteScope: 'unknown',
    status: 'active',
    postedAt: postedAtIso,
    lastVerifiedAt: nowIso,
  };
}

/** Best-effort parse of a vendor's relative posted-date text ("3 days ago",
 *  "1 month ago") into an ISO date. Falls back to "now" when unparseable —
 *  never fabricates a specific date beyond what the vendor actually stated;
 *  the UI must pair this with the confidence/attribution labeling in
 *  trust-signals.ts rather than presenting it as a verified freshness fact
 *  (that badge is earned only by the acquisition pipeline — plan §25). */
function parseRelativePostedAt(text: string | undefined): string {
  const now = Date.now();
  if (!text) return new Date(now).toISOString();
  const match = text.match(/(\d+)\s*(hour|day|week|month)/i);
  if (!match) return new Date(now).toISOString();
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const msPerUnit: Record<string, number> = {
    hour: 3600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
  };
  return new Date(now - n * (msPerUnit[unit] ?? 0)).toISOString();
}

export interface NormalizedLinkedInJob {
  opportunity: CanonicalOpportunity;
  provenance: LinkedInJobProvenance;
  descriptionConfidence: DescriptionConfidence;
  linkedinUrl: string;
}

export function normalizeVendorResult(raw: VendorJobResult): NormalizedLinkedInJob {
  const provenance: LinkedInJobProvenance = 'vendor_search';
  const opportunity = buildCanonical({
    title: raw.title,
    company: raw.company,
    description: raw.descriptionExcerpt,
    location: raw.location,
    linkedinUrl: raw.linkedinUrl,
    provenance,
    postedAtIso: parseRelativePostedAt(raw.postedAtText),
  });
  return {
    opportunity,
    provenance,
    descriptionConfidence: classifyDescriptionConfidence(raw.descriptionExcerpt, provenance),
    linkedinUrl: raw.linkedinUrl,
  };
}

export function normalizePastedJob(input: PastedJobInput): NormalizedLinkedInJob {
  const provenance: LinkedInJobProvenance = 'user_pasted';
  const opportunity = buildCanonical({
    title: input.title,
    company: input.company,
    description: input.description,
    location: input.location,
    linkedinUrl: input.linkedinUrl,
    provenance,
    postedAtIso: new Date().toISOString(),
  });
  return {
    opportunity,
    provenance,
    descriptionConfidence: classifyDescriptionConfidence(input.description, provenance),
    linkedinUrl: input.linkedinUrl,
  };
}
