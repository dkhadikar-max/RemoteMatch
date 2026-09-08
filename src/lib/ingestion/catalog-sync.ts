/**
 * RemoteMatch — Live Supply Activation: persistent catalog sync
 * ==============================================================================
 * Implements the signed Live Supply Activation spec (v2). This module owns
 * the `opportunities` table's lifecycle state machine — nothing else should
 * write `status`/`link_reachable`/`consecutive_absences`/etc. on that table.
 *
 * Lifecycle:
 *   DISCOVER -> unknown -> (immediate first link check) -> active | expired
 *   active, subsequent cycles:
 *     - still returned by a successful provider run -> stays active,
 *       consecutive_absences resets to 0
 *     - missing from a successful provider run -> consecutive_absences++;
 *       reaching 3 -> expired
 *     - a scheduled recheck (see revalidateStaleLinks) finds the link
 *       unreachable -> expired, independent of the absence counter
 *   expired jobs that reappear in a successful provider run are treated
 *   exactly like new jobs: immediate re-verification, never assumed active
 *   just because the provider listed them again.
 *
 * Provider failure (timeout/5xx/malformed response/rate-limit/auth failure)
 * produces ZERO effect on that provider's existing rows this cycle — no
 * absence increment, no counter reset, no status change. This is enforced
 * structurally: a failed provider's existing rows are never even queried
 * for absence-comparison, let alone written to.
 *
 * Does not touch matching/scoring/swipe/monetization/P0/P1 logic — this is
 * purely the upstream data source those systems read from.
 */
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { RawJobPayload, JobProvider } from '../providers/types';
import { CuratedProvider } from '../providers/curated';
import { RemotiveProvider } from '../providers/remotive';
import { ArbeitnowProvider } from '../providers/arbeitnow';
import { JobicyProvider } from '../providers/jobicy';
import {
  normalizeOpportunity,
  deduplicateOpportunities,
  verifyLinkFreshness,
} from './pipeline';

const ABSENCE_EXPIRY_THRESHOLD = 3;
const WEAK_DESCRIPTION_MIN_LENGTH = 100;

/**
 * Same fail-closed, constant-time comparison pattern already established
 * for IndexNow (src/lib/seo/indexnow.ts's verifyInternalSecret) — a
 * different secret (INGESTION_SYNC_SECRET), same discipline: no secret
 * configured means reject, not "no auth required".
 */
export function verifyIngestionSecret(authHeader: string | null): boolean {
  const secret = process.env.INGESTION_SYNC_SECRET;
  if (!secret || !authHeader) return false;

  const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  const secretBuf = Buffer.from(secret);
  const candidateBuf = Buffer.from(candidate);
  if (secretBuf.length !== candidateBuf.length) return false;

  return timingSafeEqual(secretBuf, candidateBuf);
}

export interface ProviderRunOutcome {
  sourceKey: string;
  success: boolean;
  jobCount: number;
  error?: string;
}

export interface SyncSummary {
  providerOutcomes: ProviderRunOutcome[];
  newJobsVerifiedActive: number;
  newJobsVerifiedExpired: number;
  newJobsVerificationErrored: number; // link check itself failed to run — left 'unknown'
  reappearedVerifiedActive: number;
  reappearedVerifiedExpired: number;
  refreshedExistingActive: number;
  absenceIncremented: number;
  expiredByAbsence: number;
  draftCount: number;
  explicitlyExpiredCount: number;
}

function isWeakDescription(description: string): boolean {
  return (description || '').trim().length < WEAK_DESCRIPTION_MIN_LENGTH;
}

export type ProviderFetchResult = { outcomes: ProviderRunOutcome[]; successfulRaw: Map<string, RawJobPayload[]> };

async function runProviderFetches(): Promise<ProviderFetchResult> {
  const providers: JobProvider[] = [
    new CuratedProvider(),
    new RemotiveProvider(),
    new ArbeitnowProvider(),
    new JobicyProvider(),
  ];

  const results = await Promise.allSettled(providers.map((p) => p.fetchJobs()));

  const outcomes: ProviderRunOutcome[] = [];
  const successfulRaw = new Map<string, RawJobPayload[]>();

  results.forEach((result, i) => {
    const sourceKey = providers[i].sourceKey;
    if (result.status === 'fulfilled') {
      outcomes.push({ sourceKey, success: true, jobCount: result.value.length });
      successfulRaw.set(sourceKey, result.value);
    } else {
      // Provider failure: timeout, thrown error, whatever the provider's own
      // fetchJobs() implementation surfaces as a rejection. Deliberately NOT
      // added to successfulRaw — its rows are never touched this cycle.
      outcomes.push({ sourceKey, success: false, jobCount: 0, error: String(result.reason) });
    }
  });

  return { outcomes, successfulRaw };
}

/**
 * The main sync entrypoint. Fetches all providers, upserts jobs from
 * providers that succeeded, and applies feed-absence accounting scoped only
 * to those same successful providers.
 *
 * `fetchResult` is an injection point for tests: pass a pre-built
 * { outcomes, successfulRaw } to exercise a specific, deterministic
 * provider-success/failure/absence scenario (e.g. "this provider run
 * failed outright" or "this provider succeeded but omitted job X") without
 * depending on live network behavior for that. Production code never
 * passes this — it always fetches for real.
 *
 * `options.absenceScanSourceIdPrefix` is also test-only: without it, the
 * absence-scan below correctly considers every active row for a
 * successful source (the real, required production behavior). A test that
 * injects a tiny synthetic job list would otherwise mark every OTHER real
 * active row for that source absent too — this scopes the absence-scan to
 * only source_ids starting with the given prefix, so synthetic test data
 * can exercise the exact absence-counting sequence without incrementing
 * (and risking eventually expiring) unrelated real production rows.
 */
export async function syncOpportunitiesToCatalog(
  fetchResult?: ProviderFetchResult,
  options?: { absenceScanSourceIdPrefix?: string }
): Promise<SyncSummary> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    throw new Error('Supabase admin client is not configured — cannot sync the catalog.');
  }

  const summary: SyncSummary = {
    providerOutcomes: [],
    newJobsVerifiedActive: 0,
    newJobsVerifiedExpired: 0,
    newJobsVerificationErrored: 0,
    reappearedVerifiedActive: 0,
    reappearedVerifiedExpired: 0,
    refreshedExistingActive: 0,
    absenceIncremented: 0,
    expiredByAbsence: 0,
    draftCount: 0,
    explicitlyExpiredCount: 0,
  };

  const { outcomes, successfulRaw } = fetchResult ?? (await runProviderFetches());
  summary.providerOutcomes = outcomes;

  const successfulSources = outcomes.filter((o) => o.success).map((o) => o.sourceKey);
  if (successfulSources.length === 0) {
    // Every provider failed this cycle. Nothing to upsert, nothing to
    // absence-count (there is no successful source to scope it to) — this
    // cycle is a complete no-op on the catalog, by design.
    return summary;
  }

  // Normalize + dedupe only the jobs from providers that actually succeeded.
  // normalizeOpportunity()'s own computed `.status` field (age/weak-desc
  // heuristic, from the pre-persistence design) is NOT used for catalog
  // lifecycle purposes here — this module owns status via the state machine
  // above. It IS still used to detect weak descriptions -> 'draft', which is
  // a content-quality gate, orthogonal to availability.
  const allRawFromSuccessful = successfulSources.flatMap((s) => successfulRaw.get(s) ?? []);
  // Explicit editorial override, checked before normalization discards it:
  // a provider (in practice, only the curated fixture data today) can
  // explicitly mark a specific listing 'EXPIRED' with a known
  // isPermanentlyRemoved value — e.g. a manually-curated "this role has
  // closed" or "this listing was purged" entry. That is an authoritative,
  // human-asserted fact, not something an automated link check should be
  // allowed to override — especially since a job deliberately marked
  // "removed" may point at a URL that no longer resolves at all (fail-open
  // link verification would otherwise misclassify it as reachable). Jobs
  // without an explicit raw status go through the normal unknown->verify
  // flow below, unaffected.
  const explicitOverrideByKey = new Map<string, { isPermanentlyRemoved: boolean }>();
  for (const raw of allRawFromSuccessful) {
    if (raw.status === 'EXPIRED') {
      explicitOverrideByKey.set(`${raw.source}:${raw.sourceId}`, {
        isPermanentlyRemoved: Boolean(raw.isPermanentlyRemoved),
      });
    }
  }

  const normalized = allRawFromSuccessful
    .map(normalizeOpportunity)
    .filter((o) => o.title && o.company);
  const deduped = deduplicateOpportunities(normalized);

  const presentSourceIdsBySource = new Map<string, Set<string>>();
  for (const source of successfulSources) presentSourceIdsBySource.set(source, new Set());
  for (const opp of deduped) {
    presentSourceIdsBySource.get(opp.source)?.add(opp.sourceId);
  }

  // Fetch existing rows for exactly the successful sources, keyed by
  // (source, source_id) — rows for a FAILED provider are never fetched
  // here, so they structurally cannot be touched by anything below.
  const { data: existingRows, error: fetchErr } = await admin
    .from('opportunities')
    .select('id, source, source_id, status, consecutive_absences')
    .in('source', successfulSources);
  if (fetchErr) throw new Error(`Could not read existing opportunities: ${fetchErr.message}`);

  const existingByKey = new Map(
    (existingRows ?? []).map((r) => [`${r.source}:${r.source_id}`, r])
  );

  // --- Upsert every job returned by a successful provider this cycle ---
  for (const opp of deduped) {
    const key = `${opp.source}:${opp.sourceId}`;
    const existing = existingByKey.get(key);
    const override = explicitOverrideByKey.get(key);
    // An explicit override is only ever "not applicable" for the
    // weak-description gate below, never "this row should be treated as
    // weak" — a "permanently removed" or "closed" placeholder listing is
    // naturally going to have a terse, short description (there is nothing
    // left to describe), and that must not disqualify the authoritative
    // removal fact and silently reclassify it as 'draft' instead.
    const weakDescription = !override && isWeakDescription(opp.description);

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
      required_skills: opp.requiredSkills,
      preferred_skills: opp.preferredSkills,
      experience_requirement: opp.experienceRequirement ?? null,
      quality_score: opp.qualityScore,
      explicit_remote_scope: opp.explicitRemoteScope ?? 'unknown',
      source_quality: opp.sourceQuality ?? null,
      description_completeness: opp.descriptionCompleteness ?? null,
      salary_quality: opp.salaryQuality ?? null,
      remote_policy_confidence: opp.remotePolicyConfidence ?? null,
      posted_at: opp.postedAt,
    };

    if (weakDescription) {
      // Content-quality gate, not an availability question. 'draft' rows
      // never enter the unknown/active/expired lifecycle and are never
      // absence-tracked. If a later sync brings a fuller description for
      // the same job, it naturally re-enters as 'unknown' below (since it
      // won't match this branch anymore) and gets verified like new.
      if (existing) {
        await admin.from('opportunities').update({ ...contentFields, status: 'draft', last_seen_in_feed_at: new Date().toISOString() }).eq('id', existing.id);
      } else {
        await admin.from('opportunities').insert({
          ...contentFields,
          source: opp.source,
          source_id: opp.sourceId,
          type: opp.type,
          status: 'draft',
          first_seen_at: new Date().toISOString(),
          last_seen_in_feed_at: new Date().toISOString(),
          consecutive_absences: 0,
        });
      }
      summary.draftCount++;
      continue;
    }

    if (override) {
      // Authoritative editorial override — no link check, no unknown state.
      // Applies whether this is the first time we've seen the job or an
      // update to an existing row.
      if (existing) {
        await admin
          .from('opportunities')
          .update({
            ...contentFields,
            status: 'expired',
            is_permanently_removed: override.isPermanentlyRemoved,
            last_seen_in_feed_at: new Date().toISOString(),
            consecutive_absences: 0,
          })
          .eq('id', existing.id);
      } else {
        await admin.from('opportunities').insert({
          ...contentFields,
          source: opp.source,
          source_id: opp.sourceId,
          type: opp.type,
          status: 'expired',
          is_permanently_removed: override.isPermanentlyRemoved,
          first_seen_at: new Date().toISOString(),
          last_seen_in_feed_at: new Date().toISOString(),
          consecutive_absences: 0,
        });
      }
      summary.explicitlyExpiredCount++;
      continue;
    }

    // Curated is hand-authored, editorially-controlled demo/reference
    // content, not live-scraped provider data — its listings point at real
    // company domains but the specific career-page paths are illustrative,
    // not guaranteed to resolve. Automated link verification would
    // therefore expire perfectly-intentional curated fixtures on a benign
    // 404 from a real server (unlike a live provider's dead link, which is
    // exactly what verification exists to catch). Curated jobs skip
    // straight to 'active' unless the explicit-override path above already
    // handled them — the only way a curated job is ever 'expired' is that
    // explicit, hand-authored status.
    const skipsAutomatedVerification = opp.source === 'curated';

    if (!existing) {
      if (skipsAutomatedVerification) {
        await admin.from('opportunities').insert({
          ...contentFields,
          source: opp.source,
          source_id: opp.sourceId,
          type: opp.type,
          status: 'active',
          link_reachable: null,
          first_seen_at: new Date().toISOString(),
          last_seen_in_feed_at: new Date().toISOString(),
          consecutive_absences: 0,
        });
        summary.newJobsVerifiedActive++;
        continue;
      }

      // Brand new job: unknown -> immediate first link check -> active|expired.
      const { data: inserted, error: insertErr } = await admin
        .from('opportunities')
        .insert({
          ...contentFields,
          source: opp.source,
          source_id: opp.sourceId,
          type: opp.type,
          status: 'unknown',
          first_seen_at: new Date().toISOString(),
          last_seen_in_feed_at: new Date().toISOString(),
          consecutive_absences: 0,
        })
        .select('id')
        .single();
      if (insertErr || !inserted) continue;

      const verifyResult = await verifyNewOrReappearedJob(admin, inserted.id, opp.officialUrl);
      if (verifyResult === 'active') summary.newJobsVerifiedActive++;
      else if (verifyResult === 'expired') summary.newJobsVerifiedExpired++;
      else summary.newJobsVerificationErrored++;
      continue;
    }

    if (existing.status === 'expired') {
      // Reappearance after expiry — treated exactly like a new job, never
      // assumed active just because the provider listed it again. (For
      // curated, "expired" can only have come from the explicit-override
      // branch above, so reaching here for a curated job is already an
      // explicit, deliberate editorial state — still re-verified-as-active
      // directly rather than link-checked, for the same reason as above.)
      await admin
        .from('opportunities')
        .update({ ...contentFields, last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0 })
        .eq('id', existing.id);

      if (skipsAutomatedVerification) {
        await admin.from('opportunities').update({ status: 'active' }).eq('id', existing.id);
        summary.reappearedVerifiedActive++;
        continue;
      }

      const verifyResult = await verifyNewOrReappearedJob(admin, existing.id, opp.officialUrl);
      if (verifyResult === 'active') summary.reappearedVerifiedActive++;
      else if (verifyResult === 'expired') summary.reappearedVerifiedExpired++;
      continue;
    }

    // Existing active/unknown/draft(->non-draft transition handled above)
    // row still present in a successful cycle: refresh content, reset the
    // absence counter, advance last_seen_in_feed_at. No re-verification —
    // that is revalidateStaleLinks()'s job, on its own cadence.
    await admin
      .from('opportunities')
      .update({ ...contentFields, last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0 })
      .eq('id', existing.id);
    summary.refreshedExistingActive++;
  }

  // --- Feed-absence accounting, scoped only to successful providers ---
  // Only 'active' rows are absence-tracked — 'unknown' is resolved
  // synchronously above (never persists across a cycle boundary), and
  // 'expired'/'draft' are already terminal/orthogonal states.
  for (const source of successfulSources) {
    const presentIds = presentSourceIdsBySource.get(source) ?? new Set();
    let query = admin
      .from('opportunities')
      .select('id, source_id, consecutive_absences')
      .eq('source', source)
      .eq('status', 'active');
    if (options?.absenceScanSourceIdPrefix) {
      query = query.like('source_id', `${options.absenceScanSourceIdPrefix}%`);
    }
    const { data: activeRows, error: activeErr } = await query;
    if (activeErr) continue;

    for (const row of activeRows ?? []) {
      if (presentIds.has(row.source_id)) continue; // seen this cycle, already reset above
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

/** Runs the immediate first (or post-reappearance) link check and writes
 *  the resulting active/expired status. Returns 'unknown' (left as-is) if
 *  the check itself throws unexpectedly, rather than guessing a state. */
async function verifyNewOrReappearedJob(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  opportunityId: string,
  officialUrl: string
): Promise<'active' | 'expired' | 'unknown'> {
  try {
    const check = await verifyLinkFreshness(officialUrl);
    const nextStatus = check.reachable ? 'active' : 'expired';
    await admin!
      .from('opportunities')
      .update({ status: nextStatus, link_reachable: check.reachable, link_checked_at: new Date().toISOString() })
      .eq('id', opportunityId);
    return nextStatus;
  } catch {
    // Verification itself errored (not a clean reachable:false result) —
    // leave 'unknown' rather than guessing; the next sync cycle will treat
    // this the same way (still not 'active' or 'expired', so it isn't
    // publicly visible and isn't absence-tracked either).
    return 'unknown';
  }
}

export interface RevalidationSummary {
  checked: number;
  stillReachable: number;
  expiredByLinkFailure: number;
}

/**
 * Separate, independent cadence from syncOpportunitiesToCatalog(): re-checks
 * link reachability for already-active jobs old enough (posted_at) and not
 * recently checked (link_checked_at). Never touches consecutive_absences —
 * that counter is feed-presence-only, this function is link-reachability-
 * only, per the spec's requirement that the two stay independent.
 */
export async function revalidateStaleLinks(options?: {
  olderThanDays?: number;
  recheckIntervalHours?: number;
}): Promise<RevalidationSummary> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    throw new Error('Supabase admin client is not configured — cannot revalidate links.');
  }
  const olderThanDays = options?.olderThanDays ?? 30;
  const recheckIntervalHours = options?.recheckIntervalHours ?? 24;

  const postedBefore = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const checkedBefore = new Date(Date.now() - recheckIntervalHours * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await admin
    .from('opportunities')
    .select('id, official_url, link_checked_at')
    .eq('status', 'active')
    .lt('posted_at', postedBefore)
    .or(`link_checked_at.is.null,link_checked_at.lt.${checkedBefore}`);
  if (error) throw new Error(`Could not read candidates for revalidation: ${error.message}`);

  const summary: RevalidationSummary = { checked: 0, stillReachable: 0, expiredByLinkFailure: 0 };

  for (const row of candidates ?? []) {
    summary.checked++;
    const check = await verifyLinkFreshness(row.official_url);
    await admin
      .from('opportunities')
      .update({ link_reachable: check.reachable, link_checked_at: new Date().toISOString(), ...(check.reachable ? {} : { status: 'expired' }) })
      .eq('id', row.id);
    if (check.reachable) summary.stillReachable++;
    else summary.expiredByLinkFailure++;
  }

  return summary;
}
