/**
 * Supply Discovery gate C5 — independent career-page sync orchestration
 * (docs/c5-implementation-plan.md §9)
 * ==============================================================================
 * Deliberately a SEPARATE module from catalog-sync.ts, not a new branch
 * inside `syncOpportunitiesToCatalog()`. Per C4-1/C4-3 and the C3 freeze:
 * this must run on its own cadence (daily, via its own Railway cron
 * service — dashboard-only, a post-implementation step for Deep), with its
 * own secret, never sharing a call path with the ATS/aggregator sync.
 *
 * Reuses catalog-sync.ts's PROVEN LIFECYCLE PATTERN conceptually (per §7:
 * "reused conceptually, not by shared code, per §0") — new-job insert,
 * existing-job refresh, feed-absence accounting to 'expired' — but as an
 * independent implementation against the same shared `opportunities` table,
 * scoped everywhere to `source = 'careerpage'` so it can never read or
 * write a row belonging to any other source.
 *
 * One deliberate simplification vs. catalog-sync.ts's ATS path: a brand-new
 * career-page candidate is inserted directly as 'active' (link_reachable:
 * true), not routed through the 'unknown' -> verifyLinkFreshness() step.
 * Reasoning: by the time a candidate reaches this function, CareerPageProvider
 * has already successfully fetched that exact page with a 200 response AND
 * extraction-validation.ts has confirmed every evidence-bearing field traces
 * back to that live page's own text — a stronger, more recent reachability
 * signal than a follow-up HEAD/GET check would add. revalidateStaleLinks()
 * (unmodified, source-agnostic) still re-checks these rows on its own
 * existing cadence once they age past its threshold, exactly like every
 * other source.
 *
 * Absence accounting and the 3-strikes expiry threshold mirror
 * catalog-sync.ts's values (ABSENCE_EXPIRY_THRESHOLD = 3) for consistency
 * of lifecycle behavior across the whole catalog — this is a shared
 * *convention*, not shared code; changing it here has zero effect on
 * catalog-sync.ts's own constant.
 */
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { normalizeOpportunity, deduplicateOpportunities } from './pipeline';
import { CareerPageProvider } from '@/lib/providers/career-page';
import { timingSafeEqual } from 'crypto';

const ABSENCE_EXPIRY_THRESHOLD = 3;
const CAREER_PAGE_SOURCE = 'careerpage';

/**
 * Independent secret, independent env var — matches verifyIngestionSecret's
 * fail-closed, constant-time pattern exactly, but is its own function so
 * catalog-sync.ts's export is never touched (§0). Not necessarily the same
 * secret value as INGESTION_SYNC_SECRET, per §9.
 */
export function verifyCareerPageSyncSecret(authHeader: string | null): boolean {
  const secret = process.env.CAREER_PAGE_SYNC_SECRET;
  if (!secret || !authHeader) return false;

  const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  const secretBuf = Buffer.from(secret);
  const candidateBuf = Buffer.from(candidate);
  if (secretBuf.length !== candidateBuf.length) return false;

  return timingSafeEqual(secretBuf, candidateBuf);
}

export interface CareerPageSyncSummary {
  fetchedCount: number;
  fetchFailed: boolean;
  fetchError?: string;
  newJobsInserted: number;
  refreshedExisting: number;
  absenceIncremented: number;
  expiredByAbsence: number;
}

/**
 * `providerOverride` is a test-only injection point (mirrors
 * syncOpportunitiesToCatalog()'s `fetchResult` parameter) — a test passes a
 * fake `{ fetchJobs }` implementation instead of the real CareerPageProvider,
 * so no test run ever performs a real network fetch or a real Gemini call
 * merely by calling this function. Production code (the sync route) never
 * passes this.
 */
export async function syncCareerPageOpportunities(
  providerOverride?: { fetchJobs: () => Promise<ReturnType<CareerPageProvider['fetchJobs']> extends Promise<infer T> ? T : never> }
): Promise<CareerPageSyncSummary> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    throw new Error('Supabase admin client is not configured — cannot sync career-page opportunities.');
  }

  const summary: CareerPageSyncSummary = {
    fetchedCount: 0,
    fetchFailed: false,
    newJobsInserted: 0,
    refreshedExisting: 0,
    absenceIncremented: 0,
    expiredByAbsence: 0,
  };

  const provider = providerOverride ?? new CareerPageProvider();

  let raw;
  try {
    raw = await provider.fetchJobs();
  } catch (err) {
    // Whole-run failure (e.g. DB unreachable while listing approved
    // employers) — matches syncOpportunitiesToCatalog()'s "failed provider,
    // zero effect on existing rows" discipline: nothing below runs, nothing
    // is touched.
    summary.fetchFailed = true;
    summary.fetchError = String(err);
    return summary;
  }

  summary.fetchedCount = raw.length;

  const normalized = raw.map(normalizeOpportunity).filter((o) => o.title && o.company);
  const deduped = deduplicateOpportunities(normalized);

  const presentSourceIds = new Set(deduped.map((o) => o.sourceId));

  const { data: existingRows, error: fetchErr } = await admin
    .from('opportunities')
    .select('id, source_id, status, consecutive_absences')
    .eq('source', CAREER_PAGE_SOURCE);
  if (fetchErr) throw new Error(`Could not read existing career-page opportunities: ${fetchErr.message}`);

  const existingByKey = new Map((existingRows ?? []).map((r) => [r.source_id, r]));

  for (const opp of deduped) {
    const contentFields = {
      title: opp.title,
      company: opp.company,
      company_logo: opp.companyLogo ?? null,
      description: opp.description,
      source_url: opp.sourceUrl ?? null,
      official_url: opp.officialUrl,
      canonical_url_hash: opp.canonicalUrlHash,
      content_hash: opp.contentHash,
      employment_type: opp.employmentType,
      remote_type: opp.remoteType,
      eligible_countries: opp.eligibleCountries,
      excluded_countries: opp.excludedCountries,
      timezone_requirements: opp.timezoneRequirements,
      salary_min: opp.salaryMin ?? null,
      salary_max: opp.salaryMax ?? null,
      salary_currency: opp.salaryCurrency ?? 'USD',
      salary_period: opp.salaryPeriod ?? 'unknown',
      required_skills: opp.requiredSkills,
      preferred_skills: opp.preferredSkills,
      experience_requirement: opp.experienceRequirement ?? null,
      quality_score: opp.qualityScore,
      explicit_remote_scope: opp.explicitRemoteScope ?? 'unknown',
      source_quality: opp.sourceQuality ?? null,
      description_completeness: opp.descriptionCompleteness ?? null,
      salary_quality: opp.salaryQuality ?? null,
      remote_policy_confidence: opp.remotePolicyConfidence ?? null,
    };

    const existing = existingByKey.get(opp.sourceId);

    if (!existing) {
      await admin.from('opportunities').insert({
        ...contentFields,
        source: CAREER_PAGE_SOURCE,
        source_id: opp.sourceId,
        type: opp.type,
        status: 'active',
        link_reachable: true,
        link_checked_at: new Date().toISOString(),
        posted_at: opp.postedAt,
        first_seen_at: new Date().toISOString(),
        last_seen_in_feed_at: new Date().toISOString(),
        consecutive_absences: 0,
      });
      summary.newJobsInserted++;
      continue;
    }

    if (existing.status === 'expired') {
      // Reappearance — treated as freshly-confirmed-live, same reasoning as
      // a brand-new insert above (this cycle's own successful fetch +
      // evidence validation IS the reachability confirmation).
      await admin
        .from('opportunities')
        .update({
          ...contentFields,
          status: 'active',
          link_reachable: true,
          link_checked_at: new Date().toISOString(),
          last_seen_in_feed_at: new Date().toISOString(),
          consecutive_absences: 0,
        })
        .eq('id', existing.id);
      summary.newJobsInserted++;
      continue;
    }

    await admin
      .from('opportunities')
      .update({ ...contentFields, last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0 })
      .eq('id', existing.id);
    summary.refreshedExisting++;
  }

  // --- Feed-absence accounting, scoped to source='careerpage' only ---
  const { data: activeRows, error: activeErr } = await admin
    .from('opportunities')
    .select('id, source_id, consecutive_absences')
    .eq('source', CAREER_PAGE_SOURCE)
    .eq('status', 'active');
  if (!activeErr) {
    for (const row of activeRows ?? []) {
      if (presentSourceIds.has(row.source_id)) continue;
      const nextAbsences = (row.consecutive_absences ?? 0) + 1;
      summary.absenceIncremented++;
      if (nextAbsences >= ABSENCE_EXPIRY_THRESHOLD) {
        await admin.from('opportunities').update({ consecutive_absences: nextAbsences, status: 'expired' }).eq('id', row.id);
        summary.expiredByAbsence++;
      } else {
        await admin.from('opportunities').update({ consecutive_absences: nextAbsences }).eq('id', row.id);
      }
    }
  }

  return summary;
}
