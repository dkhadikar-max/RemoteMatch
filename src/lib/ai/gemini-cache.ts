import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import type { CareerPageExtraction } from './career-page-extraction';

/**
 * AI Phase 1A — C5 Gemini extraction cache (docs/ai-phase1-implementation-
 * plan.md §4, §6, §2's gemini_extraction_cache / migration 023).
 * ==============================================================================
 * New importer of the service-role admin client (`admin.ts` trust-anchor
 * list): `gemini_extraction_cache`'s RLS has zero client policies (service-
 * role only, migration 023) and every key/value here is server-computed
 * (a content hash and a Gemini response), never client-supplied.
 *
 * A cache-table read error is treated as a MISS, never a hard failure —
 * losing a caching opportunity is not a correctness issue
 * (approved-plan §19's failure-mode matrix). A write error is logged and
 * swallowed for the same reason — caching is strictly an optimization, it
 * must never be able to fail an extraction that would otherwise succeed.
 *
 * `officialUrl` is intentionally excluded from the cached value (see
 * career-page-extraction.ts's own header comment: it's caller-supplied
 * truth, not evidence-checked) — the caller always overlays the CURRENT
 * call's officialUrl onto a cache hit.
 *
 * NOTE: this module does not itself decide whether a cache hit is "valid"
 * in the evidence sense — extraction-validation.ts's validateExtraction()
 * always re-runs against the current fetch's source text on every call,
 * cache or not. This module only answers "have we seen this exact text
 * before."
 */

type CachedExtraction = Omit<CareerPageExtraction, 'officialUrl'>;

const SCHEMA_VERSION = 1;

export async function getCachedExtraction(contentHash: string): Promise<CachedExtraction | null> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return null;

    const { data, error } = await admin
      .from('gemini_extraction_cache')
      .select('extraction')
      .eq('content_hash', contentHash)
      .eq('schema_version', SCHEMA_VERSION)
      .maybeSingle();

    if (error || !data) return null;
    return data.extraction as CachedExtraction;
  } catch (err) {
    console.warn('[gemini-cache] read failed, treating as miss (non-fatal):', err);
    return null;
  }
}

export async function setCachedExtraction(
  contentHash: string,
  extraction: CareerPageExtraction
): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return;

    const toCache: CachedExtraction = {
      title: extraction.title,
      titleEvidence: extraction.titleEvidence,
      description: extraction.description,
      locationString: extraction.locationString,
      locationEvidence: extraction.locationEvidence,
      publicationDate: extraction.publicationDate,
      publicationDateEvidence: extraction.publicationDateEvidence,
      salaryMin: extraction.salaryMin,
      salaryMax: extraction.salaryMax,
      salaryEvidence: extraction.salaryEvidence,
      jobType: extraction.jobType,
      jobTypeEvidence: extraction.jobTypeEvidence,
    };
    const { error } = await admin.from('gemini_extraction_cache').upsert(
      {
        content_hash: contentHash,
        schema_version: SCHEMA_VERSION,
        extraction: toCache,
      },
      { onConflict: 'content_hash,schema_version' }
    );
    if (error) {
      console.warn('[gemini-cache] write failed (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn('[gemini-cache] write failed (non-fatal):', err);
  }
}
