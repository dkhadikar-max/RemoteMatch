/**
 * RemoteMatch — catalog-sync lifecycle PLANNER (Phase A, Item 1b)
 * ==============================================================================
 * Pure functions only: no I/O, no clock, no environment. Everything here takes
 * its inputs as arguments and returns a description of what SHOULD be written.
 * The single writer is catalog-sync-apply.ts. Splitting decision from
 * execution is what lets the same logic run as a read-only shadow plan, as a
 * batched applier, and as a plain unit test.
 * See docs/phase-a-item-1b-spec.md for the reasoning behind every rule here.
 *
 * The rule that matters most — EVIDENCE-BOUNDED ABSENCE (spec §3):
 * "missing from this cycle's feed" only means "removed" if the fetch could have
 * contained the row. Himalayas returns just the newest ~1,500 postings, so a
 * live job that has slid out of that window is absent by construction. Counting
 * that as absence would expire ~5k live jobs in ~18h and nothing could revive
 * them. So for every source that is not a complete listing, a row can only
 * accrue an absence if row.posted_at >= the oldest postedAt this cycle fetched
 * for that source (the "floor"). Older rows are UNOBSERVABLE: not counted, not
 * touched. Complete-coverage sources (ATS boards, curated) are full listings and
 * count every absence; exempt sources (WWR) are never absence-counted at all.
 * Both non-complete kinds age out only via the unseen-retirement rule.
 */
import type { normalizeOpportunity } from './pipeline';
import { decideTranslationUpdate, applyTranslationDecision, type TranslationState } from './translation-preservation';

export type NormalizedOpp = ReturnType<typeof normalizeOpportunity>;
export type SyncMode = 'legacy' | 'shadow' | 'observe' | 'full';

/**
 * How much a source's fetch tells us about what is NOT live (spec v2 §3).
 *   complete — the fetch is a full listing, so "not returned" means "not live".
 *   windowed — the fetch is a newest-first-TRUNCATED slice; only rows at or
 *              after the fetch's oldest postedAt (the "floor") could have been
 *              in it. The default for any source not listed.
 *   exempt   — the fetch is neither complete nor newest-first-truncated (WWR:
 *              84 items, not date-ordered — Cycle 1 sampled two would-expire
 *              rows with live pages). NO absence-based expiry at all; rows leave
 *              only via the unseen-retirement rule. Set only by decision.
 */
export type CoverageKind = 'complete' | 'windowed' | 'exempt';
export const SOURCE_COVERAGE_POLICY: Readonly<Record<string, CoverageKind>> = {
  greenhouse: 'complete',
  lever: 'complete',
  ashby: 'complete',
  curated: 'complete',
  weworkremotely: 'exempt',
};
export function coverageKindFor(source: string): CoverageKind {
  return SOURCE_COVERAGE_POLICY[source] ?? 'windowed';
}

/** Unobservable windowed-source rows are retired once not seen for this long
 *  (spec §3 companion rule / decision D3). `null` disables retirement. */
export const DEFAULT_RETIREMENT_DAYS = 7;

/** Blast-radius limiter (spec §4.6): one run may expire at most
 *  max(LIMITER_MIN_ROWS, LIMITER_FRACTION x that source's scanned active rows)
 *  per source. Above that, every expiry for the source is held. */
export const LIMITER_MIN_ROWS = 200;
export const LIMITER_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Content fields
// ---------------------------------------------------------------------------

/** Exactly the columns syncOpportunitiesToCatalog() has always rewritten from
 *  the provider payload. `posted_at` is deliberately absent: it is INSERT-ONLY
 *  (see the note in catalog-sync.ts). */
export const CONTENT_FIELD_NAMES = [
  'title',
  'company',
  'company_logo',
  'description',
  'source_url',
  'official_url',
  'canonical_url_hash',
  'content_hash',
  'employment_type',
  'remote_type',
  'eligible_countries',
  'excluded_countries',
  'timezone_requirements',
  'salary_min',
  'salary_max',
  'salary_currency',
  'salary_period',
  'required_skills',
  'preferred_skills',
  'experience_requirement',
  'quality_score',
  'explicit_remote_scope',
  'source_quality',
  'description_completeness',
  'salary_quality',
  'remote_policy_confidence',
] as const;

export type ContentFieldName = (typeof CONTENT_FIELD_NAMES)[number];
export type ContentFields = Record<ContentFieldName, unknown>;

/** Mirrors, field for field, the `contentFields` literal in the legacy path
 *  (test/catalog-sync-lifecycle-suite.ts proves the two write identical rows). */
export function buildContentFields(opp: NormalizedOpp): ContentFields {
  return {
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
}

function canon(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const ca = canon(a);
  const cb = canon(b);
  if (ca === null || cb === null) return ca === cb;
  // numeric columns can round-trip as number or numeric-string
  if (typeof ca === 'number' || typeof cb === 'number') return Number(ca) === Number(cb);
  return JSON.stringify(ca) === JSON.stringify(cb);
}

/** True if ANY provider-derived column differs. contentHash alone is not
 *  enough: it covers only company/title/first-300-chars-of-description, so a
 *  salary or remote-scope change would slip past it. A false "changed" is
 *  harmless (one ordinary per-row UPDATE, exactly the legacy behaviour); a
 *  false "unchanged" would silently drop an update, so this errs to "changed". */
export function contentDiffers(existing: Partial<ContentFields> & TranslationState, fields: ContentFields): boolean {
  // A TRANSLATED row holds English title/description, so comparing them with the feed's source-language text would
  // report "changed" on every cycle (and the writer would then undo the translation). Translation-aware instead
  // (translation-preservation.ts): unchanged source text => title/description/content_hash are not compared;
  // changed source text => different, and the row must be written (and withdrawn).
  const decision = decideTranslationUpdate(existing, fields as { title: unknown; description: unknown; content_hash: unknown });
  if (decision === 'withdraw') return true;
  for (const name of CONTENT_FIELD_NAMES) {
    if (decision === 'preserve' && (name === 'title' || name === 'description' || name === 'content_hash')) continue;
    if (!valuesEqual(existing[name], fields[name])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Upsert planning
// ---------------------------------------------------------------------------

export interface ExistingRow extends Partial<ContentFields>, TranslationState {
  id: string;
  source: string;
  source_id: string;
  status: string;
  consecutive_absences: number | null;
  posted_at?: string | null;
}

export interface UpsertPolicy {
  /** ISO timestamp stamped onto every write of this run. */
  now: string;
  atsGated: ReadonlySet<string>;
  passesFreshness(postedAt: string): boolean;
  isWeakDescription(description: string): boolean;
  /** true for sources whose rows skip automated link verification (curated). */
  skipsVerification(source: string): boolean;
}

export type InsertKind = 'unknown' | 'active' | 'draft' | 'expired';

export interface PlannedInsert {
  kind: InsertKind;
  source: string;
  sourceId: string;
  officialUrl: string;
  row: Record<string, unknown>;
}

export interface PlannedContentUpdate {
  id: string;
  patch: Record<string, unknown>;
  kind: 'draft' | 'override' | 'reappeared' | 'refresh';
}

export interface PlannedVerification {
  id: string;
  source: string;
  sourceId: string;
  officialUrl: string;
  /** 'new' entries are appended by the applier once an insert has returned an id */
  reason: 'new' | 'reappeared' | 'unknown';
}

export interface UpsertPlan {
  gateSkipped: number;
  inserts: PlannedInsert[];
  /** unchanged rows: last_seen_in_feed_at + consecutive_absences = 0 */
  touchIds: string[];
  /** unchanged draft rows: last_seen_in_feed_at only (draft is not absence-tracked) */
  draftTouchIds: string[];
  contentUpdates: PlannedContentUpdate[];
  curatedReactivateIds: string[];
  verify: PlannedVerification[];
}

/** The C3 ingestion gate, defined ONCE. A rejected candidate is never inserted
 *  and never touched, so its existing row is never needed either: the lookup
 *  skips it (Cycle 1: 3,805 of 3,870 ATS keys were rejected yet looked up).
 *  It still counts as "present" for absence purposes (the caller builds that set
 *  from the un-gated list). */
export function isGateRejected(
  opp: NormalizedOpp,
  policy: Pick<UpsertPolicy, 'atsGated' | 'passesFreshness'>
): boolean {
  // Rejected when: stale, OR scope unknown, OR the location says "hybrid" with no remote marker (isHybridWithoutRemoteMarker,
  // pipeline.ts — policy "hybrid option 2"). The legacy path in catalog-sync.ts applies the same three conditions.
  return policy.atsGated.has(opp.source) && (!policy.passesFreshness(opp.postedAt) || opp.explicitRemoteScope === 'unknown' || opp.hybridWithoutRemoteMarker === true);
}

export function planUpserts(
  opps: NormalizedOpp[],
  existingByKey: ReadonlyMap<string, ExistingRow>,
  overrides: ReadonlyMap<string, { isPermanentlyRemoved: boolean }>,
  policy: UpsertPolicy
): UpsertPlan {
  const plan: UpsertPlan = {
    gateSkipped: 0,
    inserts: [],
    touchIds: [],
    draftTouchIds: [],
    contentUpdates: [],
    curatedReactivateIds: [],
    verify: [],
  };
  const now = policy.now;

  const insert = (kind: InsertKind, opp: NormalizedOpp, fields: ContentFields, extra: Record<string, unknown> = {}) => {
    plan.inserts.push({
      kind,
      source: opp.source,
      sourceId: opp.sourceId,
      officialUrl: opp.officialUrl,
      row: {
        ...fields,
        source: opp.source,
        source_id: opp.sourceId,
        type: opp.type,
        status: kind,
        ...extra,
        posted_at: opp.postedAt,
        first_seen_at: now,
        last_seen_in_feed_at: now,
        consecutive_absences: 0,
      },
    });
  };

  for (const opp of opps) {
    // Same C3 ingestion gate as the legacy path: ATS sources only, rejected
    // candidates are never inserted and never touched (but still count as
    // "present" for absence purposes — that set is built by the caller from
    // the un-gated list, exactly as before).
    if (isGateRejected(opp, policy)) {
      plan.gateSkipped++;
      continue;
    }

    const key = `${opp.source}:${opp.sourceId}`;
    const existing = existingByKey.get(key);
    const override = overrides.get(key);
    const weak = !override && policy.isWeakDescription(opp.description);
    const fields = buildContentFields(opp);
    // Translation-aware field set for an EXISTING row ('normal' = exactly `fields`, so untranslated rows are unchanged).
    const tr = existing
      ? applyTranslationDecision(fields, decideTranslationUpdate(existing, fields as { title: unknown; description: unknown; content_hash: unknown }))
      : { fields, extra: {} as { translation_status?: null } };

    if (weak) {
      if (existing) {
        if (existing.status === 'draft' && !contentDiffers(existing, fields)) {
          plan.draftTouchIds.push(existing.id);
        } else {
          plan.contentUpdates.push({ id: existing.id, kind: 'draft', patch: { ...tr.fields, ...tr.extra, status: 'draft', last_seen_in_feed_at: now } });
        }
      } else {
        insert('draft', opp, fields);
      }
      continue;
    }

    if (override) {
      if (existing) {
        plan.contentUpdates.push({
          id: existing.id,
          kind: 'override',
          patch: {
            ...tr.fields,
            ...tr.extra,
            status: 'expired',
            is_permanently_removed: override.isPermanentlyRemoved,
            last_seen_in_feed_at: now,
            consecutive_absences: 0,
          },
        });
      } else {
        insert('expired', opp, fields, { is_permanently_removed: override.isPermanentlyRemoved });
      }
      continue;
    }

    const skipsVerification = policy.skipsVerification(opp.source);

    if (!existing) {
      if (skipsVerification) insert('active', opp, fields, { link_reachable: null });
      else insert('unknown', opp, fields);
      continue;
    }

    if (existing.status === 'expired') {
      // Reappearance: treated exactly like a new job, never assumed active.
      plan.contentUpdates.push({ id: existing.id, kind: 'reappeared', patch: { ...tr.fields, ...tr.extra, last_seen_in_feed_at: now, consecutive_absences: 0 } });
      if (skipsVerification) plan.curatedReactivateIds.push(existing.id);
      else plan.verify.push({ id: existing.id, source: opp.source, sourceId: opp.sourceId, officialUrl: opp.officialUrl, reason: 'reappeared' });
      continue;
    }

    if (contentDiffers(existing, fields)) {
      plan.contentUpdates.push({ id: existing.id, kind: 'refresh', patch: { ...tr.fields, ...tr.extra, last_seen_in_feed_at: now, consecutive_absences: 0 } });
    } else {
      plan.touchIds.push(existing.id);
    }

    // FIX H (spec §2): a row left 'unknown' (verification errored, or the run
    // hit its deadline) used to fall through to the refresh branch and stay
    // invisible forever. Seeing it again now re-queues it for verification.
    if (existing.status === 'unknown') {
      if (skipsVerification) plan.curatedReactivateIds.push(existing.id);
      else plan.verify.push({ id: existing.id, source: opp.source, sourceId: opp.sourceId, officialUrl: opp.officialUrl, reason: 'unknown' });
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Absence planning
// ---------------------------------------------------------------------------

export type SourceCoverage =
  | { coverage: 'complete' }
  | { coverage: 'exempt' }
  | { coverage: 'windowed'; floorMs: number | null; /** newest postedAt fetched (window metrics) */ newestMs?: number | null };

/** `oppsBySource` must hold EVERY normalized+deduped job fetched for the source
 *  this cycle — including ones the ATS gate later rejects — because the floor
 *  describes what the FETCH covered, not what we chose to keep. */
export function computeSourceCoverage(
  oppsBySource: ReadonlyMap<string, NormalizedOpp[]>,
  sources: readonly string[]
): Map<string, SourceCoverage> {
  const out = new Map<string, SourceCoverage>();
  for (const source of sources) {
    const kind = coverageKindFor(source);
    if (kind === 'complete') {
      out.set(source, { coverage: 'complete' });
      continue;
    }
    if (kind === 'exempt') {
      out.set(source, { coverage: 'exempt' });
      continue;
    }
    let floorMs: number | null = null;
    let newestMs: number | null = null;
    for (const opp of oppsBySource.get(source) ?? []) {
      const t = Date.parse(opp.postedAt);
      if (Number.isNaN(t)) continue;
      if (floorMs === null || t < floorMs) floorMs = t;
      if (newestMs === null || t > newestMs) newestMs = t;
    }
    // null = no usable date evidence at all => nothing is observable.
    out.set(source, { coverage: 'windowed', floorMs, newestMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Window metrics (spec v2.1 D-N5)
// ---------------------------------------------------------------------------

/** The run cadence the gap check is measured against: Railway `remotematch-sync-cron` runs every 3 hours (minute 0, UTC; one POST
 *  fetches every provider, so the cadence is the same for all sources). Observed run starts are 2h56m-3h04m apart. It was 6 while the
 *  cron ran every 6h; it only feeds the reported `gapMarginHours` / `gapRisk` — no expiry, retirement or absence decision reads it. */
export const EXPECTED_CADENCE_HOURS = 3;

export interface WindowMetrics {
  /** age of the oldest fetched posting (the floor) at plan time */
  windowHours: number | null;
  /** age of the newest fetched posting at plan time — the provider's publication lag */
  newestAgeHours: number | null;
  /** windowHours − newestAgeHours − cadence. Positive = the next run's window still reaches back past
   *  this run's newest posting; negative = postings between the two runs would never be returned. */
  gapMarginHours: number | null;
  /** gapMarginHours < 0 */
  gapRisk: boolean;
}

/**
 * Measures, on every run, the property the S0 cycles sampled by hand. Why the margin subtracts the
 * newest posting's age: consecutive fetches T and T+cadence leave a gap iff the later floor is newer
 * than the earlier newest posting, i.e. windowHours(T+c) < c + newestAge(T). Cycle 2 (measured):
 * window 10.68h, newest 1.11h at the previous run, cadence 6.12h => margin +3.45h.
 * Only meaningful for `windowed` sources with date evidence; everything else reports nulls / false.
 */
export function windowMetrics(cov: SourceCoverage, asOfMs: number, cadenceHours = EXPECTED_CADENCE_HOURS): WindowMetrics {
  if (cov.coverage !== 'windowed' || cov.floorMs === null || cov.floorMs === undefined) {
    return { windowHours: null, newestAgeHours: null, gapMarginHours: null, gapRisk: false };
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const windowHours = r2((asOfMs - cov.floorMs) / 3_600_000);
  const newestAgeHours = cov.newestMs === null || cov.newestMs === undefined ? null : r2((asOfMs - cov.newestMs) / 3_600_000);
  // No newest evidence => assume no publication lag (the optimistic side is reported, never hidden: newestAgeHours is null).
  const gapMarginHours = r2(windowHours - (newestAgeHours ?? 0) - cadenceHours);
  return { windowHours, newestAgeHours, gapMarginHours, gapRisk: gapMarginHours < 0 };
}

// ---------------------------------------------------------------------------
// Employer-scope observability (spec v2.1 rule L — ATS sources only)
// ---------------------------------------------------------------------------
// An ATS adapter fetches many employer boards inside ONE provider call and swallows a per-employer
// failure (logs it, records a failure counter, omits the employer). The provider still "succeeds", so
// without this rule every row of a failed employer is planned as absent. Scope = one employer board.

/** Providers whose fetch is per-employer-board and therefore needs scope evidence. */
export const ATS_EMPLOYER_SOURCES: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby']);

export interface EmployerScopeInfo {
  boardSlug: string;
  linkedSourceId: string | null;
  /** supply_sources.last_successful_fetch_at (ms) — stamped by the adapter on success ONLY */
  lastSuccessMs: number | null;
  /** supply_sources.last_fetch_attempt_at (ms) */
  lastAttemptMs: number | null;
}

export type ScopeReason = 'fetch-failed' | 'not-attempted' | 'zero-rows-with-active' | 'evidence-unavailable' | 'unknown-scope';
export interface ScopeVerdict {
  observable: boolean;
  reason?: ScopeReason;
}

/**
 * source_id convention (verified on production rows): `<provider>-<boardSlug>-<jobId>`, e.g.
 * `lever-outreach-<uuid>`. Both slugs and ids contain hyphens, so this matches against the KNOWN
 * slugs and takes the LONGEST (`zeta-global` beats `zeta`); it never splits on '-'.
 */
export function scopeSlugFor(source: string, sourceId: string, boardSlugs: readonly string[]): string | null {
  const base = `${source}-`;
  if (!sourceId.startsWith(base)) return null;
  let best: string | null = null;
  for (const slug of boardSlugs) {
    if (sourceId.startsWith(`${base}${slug}-`) && (best === null || slug.length > best.length)) best = slug;
  }
  return best;
}

/**
 * Decides which employer scopes are observable this cycle.
 *  - `fetchStartedAtMs !== null` (bookkeeping evidence): observable iff last_successful_fetch_at >=
 *    fetchStartedAtMs. A failure, a not-reached employer and a lost bookkeeping write all read as NOT
 *    observable (fail-closed: no news is never good news).
 *  - `fetchStartedAtMs === null` (backstop only): no timestamp evidence is used.
 *  - Backstop (both modes): an employer with >= 1 active row that returned 0 rows this cycle is
 *    unobservable — a 200 with an empty body is indistinguishable from a closure.
 */
export function classifyEmployerScopes(args: {
  employers: readonly EmployerScopeInfo[];
  /** raw rows returned this cycle, by board slug */
  fetchedRawBySlug: ReadonlyMap<string, number>;
  /** active rows in the DB, by board slug */
  activeBySlug: ReadonlyMap<string, number>;
  fetchStartedAtMs: number | null;
}): Map<string, ScopeVerdict> {
  const out = new Map<string, ScopeVerdict>();
  for (const e of args.employers) {
    let verdict: ScopeVerdict = { observable: true };
    if (args.fetchStartedAtMs !== null) {
      if (e.linkedSourceId === null) verdict = { observable: false, reason: 'evidence-unavailable' };
      else if (e.lastSuccessMs !== null && e.lastSuccessMs >= args.fetchStartedAtMs) verdict = { observable: true };
      else verdict = { observable: false, reason: e.lastAttemptMs !== null && e.lastAttemptMs >= args.fetchStartedAtMs ? 'fetch-failed' : 'not-attempted' };
    }
    if (verdict.observable && (args.fetchedRawBySlug.get(e.boardSlug) ?? 0) === 0 && (args.activeBySlug.get(e.boardSlug) ?? 0) >= 1) {
      verdict = { observable: false, reason: 'zero-rows-with-active' };
    }
    out.set(e.boardSlug, verdict);
  }
  return out;
}

/** Given to planAbsence for a complete-coverage ATS source when rule L is active. */
export interface ScopeGate {
  scopeOf(sourceId: string): string | null;
  /** null (a row whose employer is not in the approved list) is never observable */
  isObservable(scope: string | null): boolean;
}

export function buildScopeGate(source: string, boardSlugs: readonly string[], verdicts: ReadonlyMap<string, ScopeVerdict>): ScopeGate {
  return {
    scopeOf: (sourceId) => scopeSlugFor(source, sourceId, boardSlugs),
    isObservable: (scope) => scope !== null && verdicts.get(scope)?.observable === true,
  };
}

export interface UnobservableScope {
  source: string;
  /** '(unknown)' groups rows whose employer is not in the approved list */
  boardSlug: string;
  reason: ScopeReason;
  activeRows: number;
}

export interface ActiveScanRow {
  id: string;
  source_id: string;
  consecutive_absences: number | null;
  posted_at: string | null;
  last_seen_in_feed_at: string | null;
  first_seen_at: string | null;
}

export interface AbsencePolicy {
  threshold: number;
  /** null disables retirement of unobservable windowed-source rows */
  retirementDays: number | null;
  nowMs: number;
  /** observe mode: plan and report expiries but write none */
  withholdExpiry: boolean;
  /** one-shot override of the blast-radius limiter */
  releaseLimiter: boolean;
}

export interface AbsencePlan {
  source: string;
  scanned: number;
  present: number;
  unobservable: number;
  /** unobservable rows whose counter is already > 0 (accrued under the old,
   *  invalid rule) — frozen, not incremented; informational (spec v2 R4) */
  legacyCountersInflated: number;
  /** next counter value -> ids (values below the threshold only) */
  incrementByValue: Map<number, string[]>;
  /** ids to actually write as expired-by-absence (empty when held) */
  expireIds: string[];
  /** ids to actually write as retired (empty when held) */
  retireIds: string[];
  wouldExpire: number;
  wouldRetire: number;
  held: { planned: number; limit: number; reason: 'limiter' | 'observe-mode' } | null;
}

export function planAbsence(
  source: string,
  rows: readonly ActiveScanRow[],
  presentSourceIds: ReadonlySet<string>,
  coverage: SourceCoverage,
  policy: AbsencePolicy,
  /** rule L: only for complete-coverage ATS sources, only when scope evidence was gathered */
  scopeGate?: ScopeGate
): AbsencePlan {
  const incrementByValue = new Map<number, string[]>();
  const expire: string[] = [];
  const retire: string[] = [];
  let present = 0;
  let unobservable = 0;
  let legacyCountersInflated = 0;

  for (const row of rows) {
    if (presentSourceIds.has(row.source_id)) {
      present++;
      continue;
    }

    const observable =
      (coverage.coverage === 'complete' && (!scopeGate || scopeGate.isObservable(scopeGate.scopeOf(row.source_id)))) ||
      (coverage.coverage === 'windowed' &&
        coverage.floorMs !== null &&
        row.posted_at != null &&
        Date.parse(row.posted_at) >= coverage.floorMs);

    if (!observable) {
      unobservable++;
      if ((row.consecutive_absences ?? 0) > 0) legacyCountersInflated++;
      // reaching here: windowed/exempt, or a complete-coverage row whose employer scope is unobservable (rule L)
      if (policy.retirementDays !== null) {
        const seen = Date.parse(row.last_seen_in_feed_at ?? row.first_seen_at ?? '');
        if (!Number.isNaN(seen) && policy.nowMs - seen > policy.retirementDays * 86_400_000) retire.push(row.id);
      }
      continue;
    }

    const next = (row.consecutive_absences ?? 0) + 1;
    if (next >= policy.threshold) {
      expire.push(row.id);
    } else {
      const bucket = incrementByValue.get(next);
      if (bucket) bucket.push(row.id);
      else incrementByValue.set(next, [row.id]);
    }
  }

  const planned = expire.length + retire.length;
  const limit = Math.max(LIMITER_MIN_ROWS, Math.ceil(LIMITER_FRACTION * rows.length));
  let held: AbsencePlan['held'] = null;
  if (planned > limit && !policy.releaseLimiter) held = { planned, limit, reason: 'limiter' };
  else if (planned > 0 && policy.withholdExpiry) held = { planned, limit, reason: 'observe-mode' };

  return {
    source,
    scanned: rows.length,
    present,
    unobservable,
    legacyCountersInflated,
    incrementByValue,
    expireIds: held ? [] : expire,
    retireIds: held ? [] : retire,
    wouldExpire: expire.length,
    wouldRetire: retire.length,
    held,
  };
}

// ---------------------------------------------------------------------------
// Report types (additive field on SyncSummary)
// ---------------------------------------------------------------------------

export interface SourceLifecycle {
  coverage: CoverageKind;
  /** ISO floor for windowed sources; null = complete/exempt coverage or no date evidence */
  floor: string | null;
  fetched: number;
  keysLookedUp: number;
  /** null when the absence pass did not run (absenceScanError set) */
  activeScanned: number | null;
  present: number;
  unobservable: number;
  /** unobservable rows already carrying an absence counter from the old rule (frozen) */
  legacyCountersInflated: number;
  /** spec v2.1 D-N5 — measured every run for windowed sources (null/false otherwise) */
  windowHours: number | null;
  newestAgeHours: number | null;
  gapMarginHours: number | null;
  gapRisk: boolean;
  /** spec v2.1 rule L — ATS sources with scope evidence only; null otherwise */
  employerScopes: { observable: number; unobservable: number; unobservableRows: number } | null;
  incremented: number;
  expired: number;
  retired: number;
  wouldExpire: number;
  wouldRetire: number;
  held: AbsencePlan['held'];
  absenceScanError?: string;
}

export interface LifecycleError {
  op: string;
  count: number;
  sample: string;
  code?: string;
}

export interface LifecycleReport {
  mode: SyncMode;
  /** false for shadow (plan only, nothing written by this path) */
  applied: boolean;
  durationMs: number;
  phaseTimingsMs: Record<string, number>;
  deadlineMs: number;
  deadlineReached: boolean;
  /** database requests issued by the lifecycle path */
  requests: number;
  bySource: Record<string, SourceLifecycle>;
  /** Fetched sources that are not in supply_platforms (so `opportunities.source`'s FK would reject
   *  every insert). Not attempted; reported here and in `errors` every run. */
  unregisteredSources: { source: string; fetched: number; skippedInserts: number }[];
  /** rule L: employer scopes whose rows were NOT absence-counted this cycle, with the reason. Never silent. */
  unobservableScopes: UnobservableScope[];
  /** how rule L got its evidence: bookkeeping (supply_sources timestamps) | backstop-only | off (no fetch evidence supplied) */
  employerEvidence: 'bookkeeping' | 'backstop-only' | 'off';
  /** windowed sources whose gapMarginHours < 0 this run */
  gapRiskSources: string[];
  /** keys the C3 gate rejects that were therefore not looked up (they still count as present) */
  lookupsSkippedByGate: number;
  existingRowsResolved: number;
  gateSkipped: number;
  inserts: { planned: number; written: number; conflicts: number };
  touched: number;
  contentUpdated: number;
  verification: {
    queued: number;
    active: number;
    expired: number;
    errored: number;
    deferred: number;
    requeuedUnknown: number;
    /** of `queued`: unknown rows the feed did NOT list this cycle (stuck-row pickup) */
    backlogQueued: number;
  };
  writeFailures: number;
  errors: LifecycleError[];
}
