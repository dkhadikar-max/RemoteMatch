import type { RawJobPayload } from '@/lib/providers/types';
import type { CareerPageExtraction } from '@/lib/ai/career-page-extraction';

/**
 * Supply Discovery gate C5 — evidence validation (docs/c5-implementation-plan.md §6)
 * ==============================================================================
 * The actual trust boundary for career-page extraction — mirrors
 * `isGeneratedKitSupported()` (src/lib/ai/anti-fabrication.ts) exactly:
 * `career-page-extraction.ts`'s Gemini call is not trusted by itself; this
 * function decides what's actually usable.
 *
 * Like `isGeneratedKitSupported()`, this is a CONSERVATIVE CLAIM SCREEN —
 * it mechanically confirms an evidence string is a real substring of the
 * source text (whitespace/case normalized), it does not semantically verify
 * the evidence actually supports the field it's attached to. A response
 * where Gemini paired the right evidence text with the wrong field label
 * would still pass this check — that's a known, accepted limitation of a
 * mechanical screen, identical in kind to the one documented in
 * anti-fabrication.ts. The screen exists to make the common failure mode
 * (invented text with no source basis at all) structurally impossible, not
 * to prove every field is semantically correct.
 *
 * `title`/`locationString`/`jobType` are the required, evidence-bearing
 * core fields: a single one failing its evidence check invalidates the
 * ENTIRE candidate — no partial publication (hard invariant, §10).
 *
 * `publicationDate` is the one explicit carve-out from that all-or-nothing
 * rule (per §6, verbatim): missing or unverifiable evidence for the date
 * does NOT invalidate the candidate — it degrades to `publicationDate:
 * null` instead, which `passesFreshnessGate()` (unmodified, from the C3
 * foundation) then correctly rejects downstream. No new date-guessing
 * logic exists anywhere in this path.
 *
 * `salary` is optional data with the same soft-degrade treatment as the
 * date: unverifiable salary is silently dropped from the candidate rather
 * than invalidating it — losing an optional number is not the same failure
 * class as showing a fabricated core fact.
 */

export interface ExtractionValidationContext {
  sourceId: string;
  source: RawJobPayload['source'];
  /** Always the allowlist_employers.canonical_name value — company name is
   *  never part of the Gemini schema, so it can never be a fabrication
   *  vector here; it is supplied by the trusted caller. */
  company: string;
  sourceUrl?: string;
}

export type ExtractionValidationResult =
  | { valid: true; candidate: RawJobPayload }
  | { valid: false; reason: string };

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function evidenceFound(evidence: string | undefined | null, sourceText: string): boolean {
  if (!evidence) return false;
  const normEvidence = normalizeForMatch(evidence);
  if (!normEvidence) return false;
  return normalizeForMatch(sourceText).includes(normEvidence);
}

export function validateExtraction(
  extraction: CareerPageExtraction,
  sourceText: string,
  context: ExtractionValidationContext
): ExtractionValidationResult {
  if (!extraction.title || !evidenceFound(extraction.titleEvidence, sourceText)) {
    return { valid: false, reason: 'title evidence not found in source text' };
  }
  if (!extraction.locationString || !evidenceFound(extraction.locationEvidence, sourceText)) {
    return { valid: false, reason: 'locationString evidence not found in source text' };
  }
  if (!extraction.jobType || !evidenceFound(extraction.jobTypeEvidence, sourceText)) {
    return { valid: false, reason: 'jobType evidence not found in source text' };
  }
  if (!extraction.description || !extraction.description.trim()) {
    return { valid: false, reason: 'description is empty' };
  }
  if (!extraction.officialUrl) {
    return { valid: false, reason: 'officialUrl missing' };
  }

  // Carve-out (§6): unverifiable date degrades to null, never invalidates.
  let publicationDate = '';
  if (extraction.publicationDate && evidenceFound(extraction.publicationDateEvidence, sourceText)) {
    const parsed = new Date(extraction.publicationDate);
    if (!Number.isNaN(parsed.getTime())) publicationDate = extraction.publicationDate;
  }

  // Optional, soft-degrade: unverifiable salary is dropped, not fatal.
  let salaryMin: number | undefined;
  let salaryMax: number | undefined;
  if (
    (extraction.salaryMin !== undefined || extraction.salaryMax !== undefined) &&
    evidenceFound(extraction.salaryEvidence, sourceText)
  ) {
    salaryMin = extraction.salaryMin;
    salaryMax = extraction.salaryMax;
  }

  const candidate: RawJobPayload = {
    sourceId: context.sourceId,
    source: context.source,
    title: extraction.title,
    company: context.company,
    description: extraction.description,
    sourceUrl: context.sourceUrl,
    officialUrl: extraction.officialUrl,
    jobType: extraction.jobType,
    locationString: extraction.locationString,
    salaryMin,
    salaryMax,
    tags: [],
    // Empty string, never a guessed date — normalizeOpportunity()/
    // passesFreshnessGate() downstream already treat an unparseable/empty
    // publicationDate as "not fresh", which is the correct, existing,
    // unmodified behavior for this case.
    publicationDate,
  };

  return { valid: true, candidate };
}
