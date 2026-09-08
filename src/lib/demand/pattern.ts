/**
 * RemoteMatch — Demand pattern normalizer (Additional Supply Discovery, gate C2)
 * ==============================================================================
 * Turns an opportunity (or an opportunity-shaped input) into a deterministic,
 * coarse DemandPattern tuple — the unit the C2 demand model measures against.
 *
 * DELIBERATELY COARSE. No clustering, no embeddings, no personalization, no
 * learned weights. The spec keeps this a fixed facet tuple because statistical
 * clustering at current verified-user volume would fit noise (see
 * docs/additional-supply-discovery-spec.md §1.1).
 *
 * Pure and deterministic: no I/O, no dependency on the matching engine or any
 * frozen classifier. `region_scope` is a 1:1 map off the ALREADY-classified
 * `remoteType` — this module never re-parses a location string
 * (classifyRemoteEligibility, a frozen contract, already did that).
 *
 * The seniority token checks below intentionally DUPLICATE (not share) the
 * strip list in pipeline.ts's createNormalizedJobKey — same discipline as
 * classifyExplicitRemoteScope vs classifyRemoteEligibility: a change to either
 * forces a review of the other, and neither can silently move the other.
 * test/demand-pattern-suite.ts asserts createNormalizedJobKey's output is
 * byte-for-byte unchanged.
 */
import type { RemoteType } from '@/types/byn';

/** Bump when any lexicon or rule below changes. Stamped into every
 *  decision_snapshot.demandPattern and every demand_gap_snapshots row so old
 *  and new observations are never silently mixed. */
export const PATTERN_LEXICON_VERSION = 'c2-lexicon-v1';

// The allowed values are the single source of truth — the types are DERIVED
// from them, so `parseDemandPatternKey` can validate at runtime against the
// exact same lists the types describe.
export const ROLE_FAMILIES = [
  'software_engineering', 'product_management', 'design', 'data',
  'marketing', 'sales', 'operations', 'other',
] as const;
export const SENIORITIES = ['junior', 'mid', 'senior', 'staff_plus'] as const;
export const REGION_SCOPES = [
  'worldwide', 'us', 'eu_eea', 'india', 'timezone_restricted', 'specific',
] as const;
export const DOMAINS = ['saas', 'fintech', 'health', 'devtools', 'ecommerce', 'ai_ml'] as const;
export const COMP_BUCKETS = ['<80k', '80-120k', '120-160k', '160k+'] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];
export type Seniority = (typeof SENIORITIES)[number];
export type RegionScope = (typeof REGION_SCOPES)[number];
export type Domain = (typeof DOMAINS)[number];
export type CompBucket = (typeof COMP_BUCKETS)[number];

export interface DemandPattern {
  role_family: RoleFamily;
  seniority: Seniority;
  region_scope: RegionScope;
  domain: Domain | null;
  comp_floor_bucket: CompBucket | null;
}

export interface DemandPatternInput {
  title: string;
  requiredSkills?: string[];
  remoteType: RemoteType;
  eligibleCountries?: string[];
  experienceRequirement?: string;
  salaryMin?: number;
  salaryCurrency?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// role_family — ordered keyword lexicon over title (+ skills as a tiebreak).
// First match wins; order matters (more specific families first).
// ---------------------------------------------------------------------------
const ROLE_FAMILY_LEXICON: Array<{ family: RoleFamily; any: string[] }> = [
  { family: 'data', any: [
    'data engineer', 'data scientist', 'data science', 'analytics engineer',
    'data analyst', 'machine learning engineer', 'ml engineer', 'mlops',
    'data platform', 'analytics manager', 'bi engineer', 'business intelligence',
  ] },
  { family: 'product_management', any: [
    'product manager', 'product management', 'group product', 'principal pm',
    'product owner', 'director of product', 'head of product', 'vp product',
    'vp of product', 'technical product manager', 'senior pm',
  ] },
  { family: 'design', any: [
    'designer', 'ux ', 'ui/ux', 'ux/ui', 'product design', 'design system',
    'design systems', 'design lead', 'creative director', 'brand designer',
    'ux researcher', 'user research',
  ] },
  { family: 'marketing', any: [
    'marketing', 'content strateg', 'content marketing', 'growth marketer',
    'demand generation', 'demand gen', 'seo', 'brand manager', 'lifecycle marketing',
    'social media manager', 'copywriter', 'communications manager',
  ] },
  { family: 'sales', any: [
    'account executive', 'sales development', 'sales manager', 'sales engineer',
    ' sdr', 'business development', 'account manager', 'sales director',
    'head of sales', 'revenue operations', 'customer success',
  ] },
  { family: 'operations', any: [
    'operations manager', 'operations lead', 'business operations', 'people operations',
    'program manager', 'project manager', 'chief of staff', 'office manager',
    'operations analyst', 'strategy & operations', 'strategy and operations',
  ] },
  { family: 'software_engineering', any: [
    'engineer', 'developer', 'swe', 'full stack', 'fullstack', 'full-stack',
    'frontend', 'front end', 'front-end', 'backend', 'back end', 'back-end',
    'software eng', 'platform engineer', 'infrastructure engineer', 'devops',
    'site reliability', ' sre', 'mobile engineer', 'ios engineer', 'android engineer',
    'security engineer', 'staff engineer', 'principal engineer', 'tech lead',
  ] },
];

function detectRoleFamily(title: string, skills: string[]): RoleFamily {
  const t = ` ${title.toLowerCase()} `;
  for (const { family, any } of ROLE_FAMILY_LEXICON) {
    if (any.some((kw) => t.includes(kw))) return family;
  }
  // Skills tiebreak — only for the two families that have clean skill signals.
  const s = skills.map((x) => x.toLowerCase());
  if (s.some((x) => ['figma', 'sketch', 'user research'].includes(x))) return 'design';
  if (s.some((x) => ['dbt', 'snowflake', 'airflow', 'spark', 'bigquery'].includes(x))) return 'data';
  return 'other';
}

// ---------------------------------------------------------------------------
// seniority — token match on title, experienceRequirement as a fallback.
// (Duplicated, not shared — see the file header.)
// ---------------------------------------------------------------------------
function detectSeniority(title: string, experienceRequirement?: string): Seniority {
  const t = ` ${title.toLowerCase()} `;
  if (/\b(principal|staff|distinguished|vp|head of|director|fellow)\b/.test(t)) return 'staff_plus';
  if (/\b(senior|sr\.?|lead|tech lead|team lead|expert)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|intern|entry[- ]?level|new grad|graduate|apprentice)\b/.test(t)) {
    return 'junior';
  }
  const exp = (experienceRequirement || '').trim();
  if (exp === '7-10' || exp === '10+') return 'senior';
  if (exp === '0-1') return 'junior';
  return 'mid';
}

// ---------------------------------------------------------------------------
// region_scope — 1:1 off the already-classified remoteType. No re-parsing.
// ---------------------------------------------------------------------------
function detectRegionScope(remoteType: RemoteType): RegionScope {
  switch (remoteType) {
    case 'Worldwide': return 'worldwide';
    case 'US': return 'us';
    case 'EU/EEA': return 'eu_eea';
    case 'India': return 'india';
    case 'Timezone restricted': return 'timezone_restricted';
    default: return 'specific'; // 'Specific countries' | 'Regional' | 'Contractor only'
  }
}

// ---------------------------------------------------------------------------
// domain — keyword lexicon over title + description + skills. null when nothing
// matches (never guessed).
// ---------------------------------------------------------------------------
const DOMAIN_LEXICON: Array<{ domain: Domain; any: string[] }> = [
  { domain: 'ai_ml', any: [
    'machine learning', 'artificial intelligence', 'generative ai', ' llm', 'llms',
    'deep learning', 'nlp', 'computer vision', 'foundation model', 'rag pipeline',
  ] },
  { domain: 'fintech', any: [
    'fintech', 'banking', 'payments', 'financial services', 'trading', 'crypto',
    'blockchain', 'lending', 'insurance', 'insurtech', 'wealth management', 'neobank',
  ] },
  { domain: 'health', any: [
    'healthcare', 'health tech', 'healthtech', 'medical', 'clinical', 'biotech',
    'telehealth', 'patient', 'life sciences', 'pharma',
  ] },
  { domain: 'devtools', any: [
    'developer tools', 'developer platform', 'devtools', 'ci/cd', 'observability',
    'internal tools', 'api platform', 'sdk', 'infrastructure platform', 'developer experience',
  ] },
  { domain: 'ecommerce', any: [
    'ecommerce', 'e-commerce', 'retail', 'marketplace', 'online store', 'shopify',
    'checkout', 'merchant', 'd2c', 'dtc',
  ] },
  { domain: 'saas', any: [
    'saas', 'b2b software', 'enterprise software', ' crm', ' erp', 'workflow automation',
    'collaboration software', 'productivity software',
  ] },
];

function detectDomain(title: string, description: string, skills: string[]): Domain | null {
  const hay = ` ${title.toLowerCase()} ${description.toLowerCase()} ${skills.join(' ').toLowerCase()} `;
  for (const { domain, any } of DOMAIN_LEXICON) {
    if (any.some((kw) => hay.includes(kw))) return domain;
  }
  return null;
}

// ---------------------------------------------------------------------------
// comp_floor_bucket — from salaryMin, normalized to USD via a fixed documented
// FX table. null when no salary or an unsupported currency (never inferred).
// ---------------------------------------------------------------------------
const FX_TO_USD: Record<string, number> = { USD: 1, GBP: 1.27, EUR: 1.09, CAD: 0.74 };

function detectCompBucket(salaryMin?: number, salaryCurrency?: string): CompBucket | null {
  if (!salaryMin || salaryMin <= 0) return null;
  const fx = FX_TO_USD[(salaryCurrency || 'USD').toUpperCase()];
  if (!fx) return null;
  const usd = salaryMin * fx;
  // Hourly/other tiny figures are not annual floors — a salaryMin under 1000 is
  // almost certainly not a yearly base; treat as unknown rather than '<80k'.
  if (usd < 1000) return null;
  if (usd < 80_000) return '<80k';
  if (usd < 120_000) return '80-120k';
  if (usd < 160_000) return '120-160k';
  return '160k+';
}

// ---------------------------------------------------------------------------

export function normalizeDemandPattern(input: DemandPatternInput): DemandPattern {
  const skills = input.requiredSkills ?? [];
  return {
    role_family: detectRoleFamily(input.title || '', skills),
    seniority: detectSeniority(input.title || '', input.experienceRequirement),
    region_scope: detectRegionScope(input.remoteType),
    domain: detectDomain(input.title || '', input.description || '', skills),
    comp_floor_bucket: detectCompBucket(input.salaryMin, input.salaryCurrency),
  };
}

/** Canonical, stable, order-fixed serialization. Same pattern -> same key. */
export function demandPatternKey(p: DemandPattern): string {
  return [
    p.role_family,
    p.seniority,
    p.region_scope,
    p.domain ?? '-',
    p.comp_floor_bucket ?? '-',
  ].join('|');
}

/** Parse a key back to a DemandPattern, VALIDATING every component against the
 *  allowed value lists at runtime (TS casts alone do not). A key with the
 *  right shape but a value outside the vocabulary — or a bad `-`/value in the
 *  nullable slots — returns `null`. */
export function parseDemandPatternKey(key: string): DemandPattern | null {
  if (typeof key !== 'string') return null;
  const parts = key.split('|');
  if (parts.length !== 5) return null;
  const [rf, sn, rs, dm, cb] = parts;

  if (!(ROLE_FAMILIES as readonly string[]).includes(rf)) return null;
  if (!(SENIORITIES as readonly string[]).includes(sn)) return null;
  if (!(REGION_SCOPES as readonly string[]).includes(rs)) return null;
  if (dm !== '-' && !(DOMAINS as readonly string[]).includes(dm)) return null;
  if (cb !== '-' && !(COMP_BUCKETS as readonly string[]).includes(cb)) return null;

  return {
    role_family: rf as RoleFamily,
    seniority: sn as Seniority,
    region_scope: rs as RegionScope,
    domain: dm === '-' ? null : (dm as Domain),
    comp_floor_bucket: cb === '-' ? null : (cb as CompBucket),
  };
}

/** True iff `key` parses to a valid DemandPattern. */
export function isValidDemandPatternKey(key: string): boolean {
  return parseDemandPatternKey(key) !== null;
}
