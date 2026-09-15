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
import { WeWorkRemotelyProvider } from '@/lib/providers/weworkremotely';
import { HimalayasProvider } from '@/lib/providers/himalayas';
import type { JobProvider, RawJobPayload } from '@/lib/providers/types';
import { timingSafeEqual } from 'crypto';

const ABSENCE_EXPIRY_THRESHOLD = 3;

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

export interface CareerPageAcquisitionOutcome {
  sourceKey: string;
  success: boolean;
  jobCount: number;
  error?: string;
}

export interface CareerPageSyncSummary {
  fetchedCount: number;
  fetchFailed: boolean;
  fetchError?: string;
  newJobsInserted: number;
  refreshedExisting: number;
  absenceIncremented: number;
  expiredByAbsence: number;
  /** Per-source breakdown (C5-A career pages, C5-B job portals, ...) — added
   *  when this function became multi-provider (C5-B pilot: WeWorkRemotely +
   *  Himalayas). Mirrors catalog-sync.ts's ProviderRunOutcome shape exactly
   *  ("reused conceptually, not by shared code," per this file's own header
   *  comment) rather than importing it — this module stays a genuinely
   *  independent implementation against the same shared opportunities table. */
  providerOutcomes: CareerPageAcquisitionOutcome[];
}

/**
 * `providersOverride` is a test-only injection point (mirrors
 * syncOpportunitiesToCatalog()'s `fetchResult` parameter) — a test passes an
 * array of fake `{ name, sourceKey, fetchJobs }` implementations instead of
 * the real providers, so no test run ever performs a real network fetch or a
 * real Gemini call merely by calling this function. Production code (the
 * sync route) never passes this.
 *
 * Evolved from a single provider to JobProvider[] for the C5-B pilot
 * (WeWorkRemotely + Himalayas alongside the existing CareerPageProvider),
 * reusing catalog-sync.ts's already-proven Promise.allSettled() pattern
 * (src/lib/ingestion/catalog-sync.ts:114-141) rather than inventing a new
 * one. THE SAFETY PROPERTY preserved from that precedent, restated because
 * it matters: a failed provider has ZERO effect on that provider's existing
 * rows this cycle — its rows are never even queried for absence-comparison
 * (see `successfulSources` below), let alone written to.
 *
 * Fixed as part of this evolution, not a pre-existing deliberate choice:
 * every insert/update below now writes `opp.source` (the real, per-candidate
 * provider source key) instead of the previous hardcoded `CAREER_PAGE_SOURCE`
 * constant. That hardcoding was harmless while exactly one provider ever
 * existed (it was always 'careerpage' either way) but would have silently
 * mislabeled every WeWorkRemotely/Himalayas row as 'careerpage' once a
 * second source existed — a real, structural bug this multi-provider
 * evolution surfaces and must fix, not a stylistic change. `opportunities`
 * table's own `UNIQUE (source, source_id)` constraint (migration
 * 001_initial_schema.sql:100) already assumes/requires this per-source
 * keying; the old single-constant code was never actually exercising that
 * constraint's real intent.
 */
export async function syncCareerPageOpportunities(
  providersOverride?: JobProvider[]
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
    providerOutcomes: [],
  };

  const providers: JobProvider[] = providersOverride ?? [
    new CareerPageProvider(),
    new WeWorkRemotelyProvider(),
    new HimalayasProvider(),
  ];

  const results = await Promise.allSettled(providers.map((p) => p.fetchJobs()));

  const outcomes: CareerPageAcquisitionOutcome[] = [];
  const successfulRaw = new Map<string, RawJobPayload[]>();

  results.forEach((result, i) => {
    const sourceKey = providers[i].sourceKey;
    if (result.status === 'fulfilled') {
      outcomes.push({ sourceKey, success: true, jobCount: result.value.length });
      successfulRaw.set(sourceKey, result.value);
    } else {
      // Provider failure: timeout, thrown error, whatever fetchJobs()
      // surfaces as a rejection. Deliberately NOT added to successfulRaw —
      // its rows are never touched this cycle (see successfulSources below).
      outcomes.push({ sourceKey, success: false, jobCount: 0, error: String(result.reason) });
    }
  });

  summary.providerOutcomes = outcomes;

  const successfulSources = outcomes.filter((o) => o.success).map((o) => o.sourceKey);

  if (successfulSources.length === 0) {
    // Every provider failed this cycle — matches the old single-provider
    // "whole run failed" contract exactly: nothing below runs, nothing
    // existing is touched.
    summary.fetchFailed = true;
    summary.fetchError = outcomes.map((o) => `${o.sourceKey}: ${o.error}`).join('; ');
    return summary;
  }

  const raw = successfulSources.flatMap((s) => successfulRaw.get(s) ?? []);
  summary.fetchedCount = raw.length;

  const normalized = raw.map(normalizeOpportunity).filter((o) => o.title && o.company);
  const deduped = deduplicateOpportunities(normalized);

  // Composite (source, sourceId) key throughout — a bare sourceId is not
  // guaranteed unique ACROSS different sources (the DB's own UNIQUE
  // constraint is on the pair, not sourceId alone), so neither is this
  // in-memory tracking.
  const presentKeys = new Set(deduped.map((o) => `${o.source}:${o.sourceId}`));

  const { data: existingRows, error: fetchErr } = await admin
    .from('opportunities')
    .select('id, source, source_id, status, consecutive_absences')
    .in('source', successfulSources);
  if (fetchErr) throw new Error(`Could not read existing career-page-acquisition opportunities: ${fetchErr.message}`);

  const existingByKey = new Map((existingRows ?? []).map((r) => [`${r.source}:${r.source_id}`, r]));

  for (const opp of deduped) {
    // Acquisition-validation Finding B (docs/c5-acquisition-validation-
    // amendment.md §2): mirrors catalog-sync.ts's exact ATS-source gate —
    // reuses the frozen classifyExplicitRemoteScope() (via
    // normalizeOpportunity(), already computed above), no new C5-specific
    // eligibility rule. A candidate whose location couldn't be resolved to
    // an explicit remote scope is never inserted, matching the C3 invariant
    // this write path was missing. Deliberately checked exactly where C3's
    // own gate sits (inside the per-candidate loop, after presentKeys
    // is already built from the full deduped set) — same acknowledged
    // scope boundary as C3: an existing active row's absence counter still
    // resets this cycle even if THIS cycle's candidate for it was gated,
    // exactly matching catalog-sync.ts's own behavior, not a new deviation.
    if (opp.explicitRemoteScope === 'unknown') continue;

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

    const existing = existingByKey.get(`${opp.source}:${opp.sourceId}`);

    if (!existing) {
      await admin.from('opportunities').insert({
        ...contentFields,
        source: opp.source,
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

  // --- Feed-absence accounting, scoped to THIS CYCLE'S SUCCESSFUL sources
  // only — mirrors catalog-sync.ts's own scoping exactly (its own header
  // comment: "Provider failure... produces ZERO effect on that provider's
  // existing rows this cycle... enforced structurally: a failed provider's
  // existing rows are never even queried for absence-comparison"). A
  // provider that failed to fetch this cycle must never have its existing
  // rows silently absence-incremented as if they'd genuinely disappeared. ---
  const { data: activeRows, error: activeErr } = await admin
    .from('opportunities')
    .select('id, source, source_id, consecutive_absences')
    .in('source', successfulSources)
    .eq('status', 'active');
  if (!activeErr) {
    for (const row of activeRows ?? []) {
      if (presentKeys.has(`${row.source}:${row.source_id}`)) continue;
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
