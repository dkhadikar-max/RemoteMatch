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
  createNormalizedJobKey,
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
      // NOTE: `posted_at` is deliberately NOT in contentFields — it is
      // INSERT-ONLY (added to each insert payload below alongside
      // first_seen_at). Re-writing it on every sync made date-less provider
      // payloads (publicationDate → now() fallback) look perpetually fresh and
      // let stale jobs dodge the >30d re-verification. Stamped once, never
      // bumped. Distinct from first_seen_at / last_seen_in_feed_at, which track
      // our catalog presence, not the posting.
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
          posted_at: opp.postedAt,
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
          posted_at: opp.postedAt,
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
          posted_at: opp.postedAt,
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
          posted_at: opp.postedAt,
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

// ==============================================================================
// M-adjacent-1 — cross-provider duplicate reconciliation (migration 018)
// ==============================================================================
// deduplicateOpportunities() (pipeline.ts) only ever compares jobs within a
// single sync cycle's freshly-fetched raw batch — it never compares against
// rows already persisted from an earlier cycle or from a provider that
// didn't return the job this cycle. Two different providers can therefore
// end up with independent, permanently-coexisting active rows for the same
// real-world job. This reconciliation pass is a separate, independently
// testable step (same pattern as revalidateStaleLinks above) that runs
// AFTER syncOpportunitiesToCatalog() and closes that gap — without
// introducing a second duplicate definition: it reads the exact same
// canonical_url_hash / normalized company+title / content_hash fingerprints
// deduplicateOpportunities() already computes and persists, never
// recomputing or altering that hierarchy.
//
// Approved lifecycle contract (see M-adjacent-1's spec):
//   - Scope: status = 'active' rows only.
//   - Cross-provider only — a same-source collision (two source_ids from
//     one provider matching) is a different provider-side problem, left
//     untouched here; per-provider (source, source_id) identity stays valid.
//   - Survivor selection: source_quality desc, then first_seen_at asc, then
//     id asc — fully deterministic.
//   - `status` / `consecutive_absences` / `link_reachable` are NEVER written
//     here. A duplicate keeps accruing its own real absence/link history
//     under the state machine above exactly as if never merged — this is
//     what makes "un-merge when the survivor is no longer active" free: the
//     duplicate was never touched, so it's already sitting at its own
//     correct current status the moment it stops being superseded.
//   - Recomputed every pass, not memorized: a pair stays merged only while
//     they still satisfy at least one current duplicate-hierarchy
//     predicate. No record of *which* predicate matched is kept — none is
//     needed, since the check is always re-derived from current data.
//   - 3+-way collisions resolve flat: every non-survivor in a cluster points
//     directly at the single deterministic survivor. A survivor can never
//     itself carry a non-null pointer — guaranteed structurally by ranking
//     the whole cluster at once and assigning every non-top member to the
//     one top member, never chaining through an intermediate row.

interface ReconciliationRow {
  id: string;
  source: string;
  company: string;
  title: string;
  canonical_url_hash: string | null;
  content_hash: string | null;
  source_quality: number | null;
  first_seen_at: string | null;
  superseded_by_opportunity_id: string | null;
}

export interface ReconciliationSummary {
  activeRowsScanned: number;
  crossProviderClustersFound: number;
  newlyMerged: number;
  unmerged: number;
  alreadyCorrect: number;
}

/** Minimal union-find (disjoint-set) over row ids, used to cluster rows that
 *  are transitively connected via ANY of the three cross-provider-relevant
 *  fingerprints — e.g. A~B via URL and B~C via title correctly land C in
 *  the same cluster as A, even though A and C share no single key directly. */
class DisjointSet {
  private parent = new Map<string, string>();

  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Clusters active rows by the same three predicates deduplicateOpportunities()
 *  uses for cross-batch dedup (source+sourceId, layer 1, is intentionally
 *  excluded here — it can never connect two DIFFERENT providers' rows, which
 *  is the only case this function cares about). Exported for unit testing
 *  independent of any database. */
export function clusterActiveRowsForReconciliation(
  rows: ReconciliationRow[]
): ReconciliationRow[][] {
  const ds = new DisjointSet();
  for (const row of rows) ds.add(row.id);

  const byUrlHash = new Map<string, string[]>();
  const byCompanyTitle = new Map<string, string[]>();
  const byContentHash = new Map<string, string[]>();

  for (const row of rows) {
    if (row.canonical_url_hash) {
      (byUrlHash.get(row.canonical_url_hash) ?? byUrlHash.set(row.canonical_url_hash, []).get(row.canonical_url_hash)!).push(row.id);
    }
    const ctKey = createNormalizedJobKey(row.company, row.title);
    (byCompanyTitle.get(ctKey) ?? byCompanyTitle.set(ctKey, []).get(ctKey)!).push(row.id);
    if (row.content_hash) {
      (byContentHash.get(row.content_hash) ?? byContentHash.set(row.content_hash, []).get(row.content_hash)!).push(row.id);
    }
  }

  for (const map of [byUrlHash, byCompanyTitle, byContentHash]) {
    for (const ids of Array.from(map.values())) {
      for (let i = 1; i < ids.length; i++) ds.union(ids[0], ids[i]);
    }
  }

  const clusters = new Map<string, ReconciliationRow[]>();
  for (const row of rows) {
    const root = ds.find(row.id);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(row);
  }
  return Array.from(clusters.values());
}

/** Deterministic survivor selection: source_quality desc, first_seen_at
 *  asc, id asc. Exported for unit testing independent of any database. */
export function rankClusterForSurvivor(members: ReconciliationRow[]): ReconciliationRow[] {
  return [...members].sort((a, b) => {
    const qa = a.source_quality ?? -1;
    const qb = b.source_quality ?? -1;
    if (qa !== qb) return qb - qa;
    const ta = a.first_seen_at ? new Date(a.first_seen_at).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.first_seen_at ? new Date(b.first_seen_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The reconciliation entrypoint. Called once, after a successful
 * syncOpportunitiesToCatalog() cycle (never inside it) — see the sync
 * route. Full recomputation every call: reads every currently-'active' row
 * fresh, re-derives clusters from current fingerprint data, and writes only
 * `superseded_by_opportunity_id`. Never reads or writes `status`,
 * `consecutive_absences`, or `link_reachable`.
 */
export async function reconcileCrossProviderDuplicates(): Promise<ReconciliationSummary> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    throw new Error('Supabase admin client is not configured — cannot reconcile duplicates.');
  }

  const summary: ReconciliationSummary = {
    activeRowsScanned: 0,
    crossProviderClustersFound: 0,
    newlyMerged: 0,
    unmerged: 0,
    alreadyCorrect: 0,
  };

  const { data, error } = await admin
    .from('opportunities')
    .select('id, source, company, title, canonical_url_hash, content_hash, source_quality, first_seen_at, superseded_by_opportunity_id')
    .eq('status', 'active');
  if (error) throw new Error(`Could not read active opportunities for reconciliation: ${error.message}`);

  const rows = (data ?? []) as ReconciliationRow[];
  summary.activeRowsScanned = rows.length;

  const clusters = clusterActiveRowsForReconciliation(rows);

  for (const members of clusters) {
    const distinctSources = new Set(members.map((m) => m.source));

    if (distinctSources.size <= 1) {
      // Same-provider (or lone) cluster — out of scope for this ticket. A
      // member here might still carry a stale pointer from a PRIOR pass
      // where its cross-provider counterpart was active and clustered with
      // it — that counterpart has since left the active-row scan entirely
      // (expired, or its own fingerprints diverged), so clear it.
      for (const m of members) {
        if (m.superseded_by_opportunity_id !== null) {
          await admin.from('opportunities').update({ superseded_by_opportunity_id: null }).eq('id', m.id);
          summary.unmerged++;
        }
      }
      continue;
    }

    summary.crossProviderClustersFound++;
    const ranked = rankClusterForSurvivor(members);
    const survivor = ranked[0];

    if (survivor.superseded_by_opportunity_id !== null) {
      await admin.from('opportunities').update({ superseded_by_opportunity_id: null }).eq('id', survivor.id);
      summary.unmerged++;
    } else {
      summary.alreadyCorrect++;
    }

    for (const dup of ranked.slice(1)) {
      if (dup.superseded_by_opportunity_id === survivor.id) {
        summary.alreadyCorrect++;
        continue;
      }
      await admin.from('opportunities').update({ superseded_by_opportunity_id: survivor.id }).eq('id', dup.id);
      summary.newlyMerged++;
    }
  }

  return summary;
}
