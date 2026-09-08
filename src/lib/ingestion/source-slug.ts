/**
 * RemoteMatch — source slug vocabulary (Additional Supply Discovery, gate C1)
 * ==============================================================================
 * Before C1, `opportunities.source` was typed as the closed union
 * `'curated' | 'remotive' | 'arbeitnow' | 'jobicy'` in several places — but the
 * database column was always plain `TEXT NOT NULL` with no constraint, so that
 * union was a compile-time fiction. C1 makes the set genuinely dynamic (an FK
 * to `supply_platforms.slug`, populated by the discovery registry) and moves
 * the type surface here.
 *
 * `source` is the ACQUISITION PLATFORM, not a per-employer value — kept
 * deliberately low-cardinality (see the C1 plan, decision Q1). Per-employer /
 * per-board identity lives in `opportunities.source_id` and in the
 * `supply_sources` registry, never in `source`.
 */

/** The four sources that predate the registry. Still the only ones the
 *  hard-coded provider list in catalog-sync.ts fetches — C3 makes that
 *  registry-driven. Kept as a strict tuple so the Phase A providers stay
 *  honestly typed. */
export const BUILTIN_SOURCE_SLUGS = ['curated', 'remotive', 'arbeitnow', 'jobicy'] as const;
export type BuiltinSourceSlug = (typeof BUILTIN_SOURCE_SLUGS)[number];

/**
 * A registered source (platform) slug. Not a closed union — the set grows as
 * the discovery registry approves platforms. Constrained at the database by
 * `supply_platforms.slug CHECK (slug ~ '^[a-z0-9]+$')`: lowercase, digits, no
 * hyphens or underscores. The hyphen-free guarantee is what keeps the
 * `opp-<source>-<source_id>` canonical id unambiguously segmentable.
 */
export type SourceSlug = string;

/** True when `s` is shaped like a valid platform slug (the same rule the DB
 *  CHECK enforces). Use at any adapter/ingestion boundary that accepts a slug
 *  from outside the registry. */
export function isWellFormedSourceSlug(s: string): boolean {
  return /^[a-z0-9]+$/.test(s);
}

/**
 * Provenance quality per built-in source — a hand-set 0–100 hint that predates
 * any outcome evidence, surfaced on `CanonicalOpportunity.sourceQuality`.
 * A source NOT in this map (i.e. anything the discovery registry adds later)
 * resolves to `undefined` on purpose: we make no quality claim about a source
 * we have no evidence for (C1 plan decision Q4 — consistent with the P1
 * evidence-ladder discipline). The column is nullable; catalog-sync writes
 * `?? null`.
 */
export const BUILTIN_SOURCE_QUALITY: Record<BuiltinSourceSlug, number> = {
  curated: 95,
  remotive: 90,
  arbeitnow: 88,
  jobicy: 85,
};

export function sourceQualityFor(slug: string): number | undefined {
  return (BUILTIN_SOURCE_QUALITY as Record<string, number | undefined>)[slug];
}
