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

/** Every active listing (RLS), reduced to its eligibility fields. Pages over a
 *  deterministic (source, source_id) order so a concurrent write cannot skip or
 *  repeat rows across the 1,000-row PostgREST pages. */
export async function loadResumeEligibilityRows(supabase: SupabaseClient): Promise<ResumeEligibilityRow[]> {
  const out: ResumeEligibilityRow[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('opportunities')
      .select(RESUME_ELIGIBILITY_COLUMNS)
      .order('source', { ascending: true })
      .order('source_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not read resume eligibility rows: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as unknown as Array<{ title: string; remote_type: string | null; employment_type: string | null; required_skills: string[] | null }>) {
      out.push({ title: r.title, remoteType: r.remote_type, employmentType: r.employment_type, requiredSkills: r.required_skills ?? [] });
    }
    if (data.length < pageSize) break;
    from += pageSize;
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
