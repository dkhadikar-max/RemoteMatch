/**
 * RemoteMatch — ATS employer registry (Supply Discovery gate C3)
 * ==============================================================================
 * Reads the existing `allowlist_employers` table (created empty in migration
 * 012, gate C1) to drive registry-based ATS ingestion — the "registry-driven
 * orchestration" required by the C3 implementation plan (docs/c3-implementation
 * -plan.md). This module intentionally does NOT create a parallel registry:
 * `allowlist_employers` already has every field an ATS adapter needs
 * (`ats_provider`, `career_url`, `review_status`, `linked_source_id`).
 *
 * Per-employer fetch reliability (success/failure counters, timestamps) is
 * tracked on the LINKED `supply_sources` row, not here — that table already
 * carries `consecutive_fetch_failures`/`last_fetch_attempt_at`/
 * `last_successful_fetch_at`/`first_fetch_at`/`last_job_seen_at`/
 * `lifetime_jobs_ingested` (migration 012). This module only reads the
 * employer list and writes those existing counters; it adds no schema.
 */
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export interface ApprovedEmployer {
  id: string;
  canonicalName: string;
  careerUrl: string;
  /** The ATS board slug for this employer — the last path segment of
   *  career_url by convention (e.g. 'gitlab' for Greenhouse, 'spotify' for
   *  Lever, 'notion' for Ashby). Stored explicitly rather than parsed from
   *  career_url so a provider never has to guess board-slug conventions. */
  boardSlug: string;
  linkedSourceId: string | null;
}

/**
 * Approved, ready-to-poll employers for one ATS provider. Only
 * review_status='approved' rows are ever returned — a 'pending' or
 * 'rejected' employer is never polled, matching the C3 plan's "discovery
 * does not equal publication" rule.
 */
export async function getApprovedEmployers(atsProvider: 'greenhouse' | 'lever' | 'ashby'): Promise<ApprovedEmployer[]> {
  const admin = getSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from('allowlist_employers')
    .select('id, canonical_name, career_url, linked_source_id')
    .eq('ats_provider', atsProvider)
    .eq('review_status', 'approved');

  if (error || !data) return [];

  return data
    .map((row) => {
      const slugMatch = row.career_url?.match(/([a-zA-Z0-9_-]+)\/?$/);
      const boardSlug = slugMatch ? slugMatch[1] : null;
      if (!boardSlug) return null;
      return {
        id: row.id,
        canonicalName: row.canonical_name,
        careerUrl: row.career_url,
        boardSlug,
        linkedSourceId: row.linked_source_id,
      };
    })
    .filter((e): e is ApprovedEmployer => e !== null);
}

/** Records a successful fetch for one employer's linked supply_sources row.
 *  Never throws — a bookkeeping failure must never abort ingestion for that
 *  employer's jobs, which have already been fetched successfully by the
 *  time this is called. */
export async function recordEmployerFetchSuccess(linkedSourceId: string | null, jobCount: number): Promise<void> {
  if (!linkedSourceId) return;
  const admin = getSupabaseAdminClient();
  if (!admin) return;
  try {
    const now = new Date().toISOString();
    await admin
      .from('supply_sources')
      .update({
        consecutive_fetch_failures: 0,
        last_fetch_attempt_at: now,
        last_successful_fetch_at: now,
        ...(jobCount > 0 ? { last_job_seen_at: now } : {}),
      })
      .eq('id', linkedSourceId);
  } catch {
    // Bookkeeping only — never let this fail the calling provider.
  }
}

/** Records a failed fetch for one employer. Per the C3 plan's per-employer
 *  failure isolation requirement: this NEVER throws, and the caller is
 *  expected to continue to the next employer regardless of this call's
 *  outcome — one employer's failure must never be interpreted as "the
 *  whole platform is down." */
export async function recordEmployerFetchFailure(linkedSourceId: string | null): Promise<void> {
  if (!linkedSourceId) return;
  const admin = getSupabaseAdminClient();
  if (!admin) return;
  try {
    const { data } = await admin
      .from('supply_sources')
      .select('consecutive_fetch_failures')
      .eq('id', linkedSourceId)
      .single();
    await admin
      .from('supply_sources')
      .update({
        consecutive_fetch_failures: (data?.consecutive_fetch_failures ?? 0) + 1,
        last_fetch_attempt_at: new Date().toISOString(),
      })
      .eq('id', linkedSourceId);
  } catch {
    // Bookkeeping only — never let this fail the calling provider.
  }
}
