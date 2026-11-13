/**
 * Slim, cached catalog read for the resume "Grow your matches" route.
 * ==============================================================================
 * GET /api/resume/opportunities used to read the WHOLE catalog (every column,
 * descriptions included — ~21 MB over the wire at ~23k rows) on every call, per
 * user, just to count which skills the caller's hard-eligible jobs ask for.
 *
 * What that route actually needs from a listing is exactly what
 * checkHardEligibility() reads — `remoteType`, `employmentType`, `title` and
 * `requiredSkills` — plus `requiredSkills` for the skill counts. That is four
 * narrow columns (~150 B/row against ~2.7 KB for a full row). They are read once
 * into a process-wide TTL cache shared by every user (and dropped by the sync
 * routes when ingestion writes), so a request costs no Supabase read at all.
 *
 * Behavior is unchanged from the old full read: same rows (every active row, via
 * RLS — no freshness window and no translation gate, as before; this feeds an
 * aggregate "skills in demand" statistic, not a listing), same eligibility
 * function, same counts. test/resume-feed-egress-suite.ts pins both that
 * equivalence and the fact that checkHardEligibility() reads nothing else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalOpportunity } from '@/types/byn';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { createAsyncTtlCache, type TtlCache } from '@/lib/seo/ttl-cache';
import { getOrCreateCatalogCache, catalogTtlMs } from '@/lib/ingestion/catalog-caches';

/** The columns checkHardEligibility() + computeSkillOpportunities() read — nothing more. */
export const RESUME_ELIGIBILITY_COLUMNS = 'title, remote_type, employment_type, required_skills';

export interface ResumeEligibilityRow {
  title: string;
  remoteType: string | null;
  employmentType: string | null;
  requiredSkills: string[];
}

export const RESUME_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
export const RESUME_INDEX_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/** Every active listing (RLS), reduced to the four eligibility fields plus
 *  internal composite cursor keys. Uses the unique (source, source_id) index
 *  for bounded keyset pages; never OFFSET-scans the catalog tail. */
export async function loadResumeEligibilityRows(supabase: SupabaseClient): Promise<ResumeEligibilityRow[]> {
  const out: ResumeEligibilityRow[] = [];
  const initialPageSize = 1000;
  let pageSize = initialPageSize;
  let afterSource: string | null = null;
  let afterSourceId: string | null = null;
  let pageIndex = 0;

  while (true) {
    const cursor = afterSource === null ? null : { source: afterSource, sourceId: afterSourceId };
    let pageStartedAt = performance.now();
    let response = await supabase.rpc('get_resume_eligibility_page', {
      p_after_source: afterSource,
      p_after_source_id: afterSourceId,
      p_page_size: pageSize,
    });
    let durationMs = Math.round((performance.now() - pageStartedAt) * 100) / 100;

    for (let retry = 0; response.error?.code === '57014' && pageSize > 25 && retry < 5; retry++) {
      const failedPageSize = pageSize;
      pageSize = Math.max(25, Math.floor(pageSize / 2));
      console.warn('[resume] eligibility-page-retry', JSON.stringify({
        page: pageIndex, cursor, failedPageSize, retryPageSize: pageSize, durationMs,
        code: response.error.code,
      }));
      pageStartedAt = performance.now();
      response = await supabase.rpc('get_resume_eligibility_page', {
        p_after_source: afterSource,
        p_after_source_id: afterSourceId,
        p_page_size: pageSize,
      });
      durationMs = Math.round((performance.now() - pageStartedAt) * 100) / 100;
    }

    const { data, error } = response;
    if (error) {
      console.error('[resume] eligibility-page-failed', JSON.stringify({
        page: pageIndex, cursor, pageSize, durationMs,
        code: error.code ?? null, message: error.message,
      }));
      throw new Error(`Could not read resume eligibility rows: ${error.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error('Resume eligibility keyset RPC returned an invalid payload');
    }

    const rows = data as unknown as Array<{
      source: string;
      source_id: string;
      title: string;
      remote_type: string | null;
      employment_type: string | null;
      required_skills: string[] | null;
    }>;
    console.info('[resume] eligibility-page', JSON.stringify({
      page: pageIndex, pageSize, rows: rows.length, durationMs, cursor,
    }));
    pageIndex += 1;
    if (rows.length === 0) break;

    for (const r of rows) {
      out.push({
        title: r.title,
        remoteType: r.remote_type,
        employmentType: r.employment_type,
        requiredSkills: r.required_skills ?? [],
      });
    }

    const last = rows[rows.length - 1];
    if (!last.source || !last.source_id) {
      throw new Error('Resume eligibility keyset RPC returned a row without its cursor key');
    }
    afterSource = last.source;
    afterSourceId = last.source_id;
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * A stand-in with just the fields the eligibility check and skill counts read,
 * typed as a CanonicalOpportunity so the (frozen) matcher can be called
 * unchanged. Safe ONLY because test/resume-feed-egress-suite.ts asserts that
 * checkHardEligibility() and computeSkillOpportunities() read no other field.
 */
export function asEligibilityOpportunity(r: ResumeEligibilityRow): CanonicalOpportunity {
  return { title: r.title, remoteType: r.remoteType, employmentType: r.employmentType, requiredSkills: r.requiredSkills } as unknown as CanonicalOpportunity;
}

const cache: TtlCache<ResumeEligibilityRow[]> = getOrCreateCatalogCache('resume-eligibility', () =>
  createAsyncTtlCache<ResumeEligibilityRow[]>(
    async () => {
      const supabase = createSupabasePublicClient();
      if (!supabase) throw new Error('Supabase is not configured');
      return loadResumeEligibilityRows(supabase);
    },
    {
      ttlMs: catalogTtlMs(RESUME_INDEX_TTL_MS),
      maxStaleMs: RESUME_INDEX_MAX_STALE_MS,
      onStaleServed: (err) =>
        console.warn('[resume] eligibility index refresh failed; serving the last good copy:', err instanceof Error ? err.message : err),
    }
  )
);

/** The cached eligibility rows (a shared array — treat as read-only). */
export function getResumeEligibilityRows(): Promise<ResumeEligibilityRow[]> {
  return cache.get();
}
