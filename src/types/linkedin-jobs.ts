/**
 * LinkedIn Job Finder (Pro) — types.
 * See C:\Users\dell\.claude\plans\vivid-hatching-kitten.md for the full
 * audit/architecture this implements.
 *
 * These jobs are NEVER written to `opportunities` and NEVER flow through
 * src/lib/ingestion/catalog-sync.ts or pipeline.ts — see normalize.ts for
 * why a LinkedInJobResult is CanonicalOpportunity-SHAPED but deliberately
 * NOT a real catalog opportunity (id namespace, `source: 'linkedin'` never
 * registered in `supply_platforms`).
 */

export interface LinkedInJobSearchFilters {
  keywords?: string;
  location?: string;
  remoteOnly?: boolean;
  /** Free text (e.g. "entry", "mid", "senior") — mapped best-effort into the
   *  vendor query; never used to gate matching (engine.ts's existing
   *  experienceRequirement comparison is the only eligibility-relevant use). */
  experienceLevel?: string;
  datePosted?: 'any' | 'past24h' | 'pastWeek' | 'pastMonth';
  company?: string;
  jobType?: string;
}

/**
 * The trimmed shape RemoteMatch actually uses from a vendor (licensed
 * Google-Jobs-data reseller) search result — see vendor.ts's doc comment
 * for the full provenance chain. `linkedinUrl` is the vendor's own
 * `apply_options` entry that pointed at linkedin.com; a raw vendor result
 * with no such entry never reaches this shape (filtered out in vendor.ts).
 */
export interface VendorJobResult {
  title: string;
  company: string;
  location?: string;
  /** A real, vendor-provided description excerpt (Google-derived) — often,
   *  not always, truncated. Never the full LinkedIn posting body; see
   *  normalize.ts's confidence flag. */
  descriptionExcerpt: string;
  /** Vendor-provided relative freshness signal (e.g. "3 days ago"), if any.
   *  Never converted into a claimed exact date — see trust-signals.ts. */
  postedAtText?: string;
  /** The real linkedin.com URL this result's LinkedIn apply option points to. */
  linkedinUrl: string;
}

export type LinkedInJobProvenance = 'vendor_search' | 'user_pasted';

/** Whether the description backing a match is the full posting text (safe
 *  to match on with full confidence) or only a vendor-provided excerpt
 *  (real, but possibly truncated — matches should be labeled accordingly). */
export type DescriptionConfidence = 'full' | 'excerpt';

/** Fields a user supplies when pasting a specific job themselves (§26 Mode
 *  B/C of the plan). `rawText` is the single-paste path; the rest are the
 *  structured-fields confirm/edit step, always present after parsing. */
export interface PastedJobInput {
  title: string;
  company: string;
  description: string;
  linkedinUrl: string;
  location?: string;
}
