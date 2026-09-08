/**
 * RemoteMatch — Demand / supply measurement job (Additional Supply Discovery, C2)
 * ==============================================================================
 * `computeGapTable` is PURE (plain arrays in, MeasurementResult out) so every
 * rule below is unit-testable. `measureDemandGap` is the thin I/O wrapper the
 * route / runner call. NOTHING consumes the result — instrumentation only.
 *
 * Signal sources (spec §1.2) — only what has server-side data today:
 *   - revealed_demand          : swipes.decision_snapshot.demandPatternKey
 *   - application_progression   : an application_events status_changed -> 'applied'
 *     (the raw 'interested' application rows are the swipe mirror — AMENDMENT 2:
 *      NOT counted as an independent signal)
 *   - active_user_requirement   : NO SOURCE (onboarding writes localStorage only)
 *   - search_filter_activity    : NO SOURCE (filters are client-side only)
 *
 * Constants are PLACEHOLDERS ('c2-placeholder-v1') — current volume cannot
 * calibrate them (docs/c2-addendum.md). demand_factor = 0 and min_target =
 * max_target.
 *
 * THE C2 GAP-SCORE INVARIANT (round-2 review): `gap_score` is emitted ONLY when
 * `adequacy.gapRankingAuthorized` is true — i.e. the dataset is structurally
 * measurable AND the numeric D3 evidence bar has been derived and approved. In
 * C2 the D3 bar is ALWAYS 'deferred', so `gap_score` is ALWAYS null here, with
 * `gap_score_status = 'withheld_d3_evidence_bar_deferred'`. This holds even
 * after a future run becomes structurally measurable — structural measurability
 * alone never unlocks a ranking. (AMENDMENT 1 — inadequate data — is a second,
 * independent withholding reason, checked only once the D3 bar is authorized.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemoteType } from '@/types/byn';
import {
  normalizeDemandPattern,
  demandPatternKey,
  parseDemandPatternKey,
  DemandPattern,
  PATTERN_LEXICON_VERSION,
} from './pattern';
import { assessDatasetAdequacy } from './adequacy';

export const CONSTANTS_VERSION = 'c2-placeholder-v1';

/** Placeholder constants — documented, NOT calibrated. See docs/c2-addendum.md. */
export const C2_CONSTANTS = {
  recencyHalfLifeDays: 30,
  signalBaseWeight: { swipe_interested: 1.0, swipe_passed: 0.1, application_applied: 3.0 },
  base: 20,
  demandFactor: 0, // deliberately inert until calibrated
  minTarget: 20,
  maxTarget: 20,
  staleDays: 45,
  defaultWindowDays: 90,
};

function recencyWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / C2_CONSTANTS.recencyHalfLifeDays);
}
function ageDays(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 86_400_000;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Pure inputs

export interface MeasureOppRow {
  canonical_id: string;
  title: string;
  description: string | null;
  required_skills: string[] | null;
  remote_type: string;
  eligible_countries: string[] | null;
  experience_requirement: string | null;
  salary_min: number | null;
  salary_currency: string | null;
  posted_at: string;
  link_checked_at: string | null;
}
export interface MeasureSwipeRow {
  profile_id: string;
  opportunity_id: string;
  action: string;
  created_at: string;
  decision_snapshot: Record<string, unknown> | null;
}
export interface MeasureAppliedEvent {
  application_id: string;
  profile_id: string;
  opportunity_id: string;
  applied_event_at: string | null; // earliest status_changed -> 'applied'; null = no genuine transition
}

export interface RankedGap {
  pattern: DemandPattern;
  pattern_key: string;
  demand_weight: number;
  active_supply: number;
  effective_supply: number;
  target_supply: number;
  shortfall: number;
  gap_score: number | null;
  gap_score_status:
    | 'computed'
    | 'withheld_d3_evidence_bar_deferred'          // C2: numeric D3 bar not derived/approved
    | 'withheld_dataset_not_structurally_measurable'; // future: D3 bar authorized but data too thin (AMENDMENT 1)
  observations: number;
  distinct_users: number;
}

export interface MeasurementResult {
  computed_at: string;
  window_start: string;
  window_end: string;
  signals_available: string[];
  constants_version: string;
  lexicon_version: string;
  verified_active_users: number;
  distinct_demand_patterns: number;
  total_demand_observations: number;
  revealed_demand_observations: number;
  application_progression_observations: number;
  progression_unattributable: number;
  /** (1) mechanics have enough data to run the measurement — structural facts only. */
  structurally_measurable: boolean;
  /** (2) the numeric D3 evidence bar — ALWAYS 'deferred' in C2. */
  d3_evidence_status: 'deferred' | 'authorized';
  /** `gap_score` is emitted ONLY when this is true — ALWAYS false in C2. */
  gap_ranking_authorized: boolean;
  /** migration-013 column. = `structurally_measurable` (the dataset's own
   *  adequacy). The gap-ranking guard is `gap_ranking_authorized`, which is
   *  separate and always false in C2. */
  dataset_adequate: boolean;
  adequacy_detail: ReturnType<typeof assessDatasetAdequacy>;
  ranked_gaps: RankedGap[];
  notes: string;
}

function patternOf(o: MeasureOppRow): DemandPattern {
  return normalizeDemandPattern({
    title: o.title,
    requiredSkills: o.required_skills ?? [],
    remoteType: o.remote_type as RemoteType,
    eligibleCountries: o.eligible_countries ?? [],
    experienceRequirement: o.experience_requirement ?? undefined,
    salaryMin: o.salary_min ?? undefined,
    salaryCurrency: o.salary_currency ?? undefined,
    description: o.description ?? undefined,
  });
}

/**
 * PURE. Given the raw rows for one window, produce the measurement + adequacy
 * verdict + ranked gaps (with AMENDMENT 1 withholding applied).
 */
export function computeGapTable(args: {
  now: number;
  windowStart: string;
  windowEnd: string;
  activeOpps: MeasureOppRow[];
  swipes: MeasureSwipeRow[];        // already filtered to the window
  appliedEvents: MeasureAppliedEvent[];
  priorPatternKeys: string[];
  hasPriorSnapshots: boolean;
  /** Real (non-test) profile ids. Observations from any other profile are
   *  ignored — disposable `remotematch-test-*` accounts run by the test
   *  suites (esp. outcome-lifecycle) otherwise dominate the demand signal.
   *  `null` = count every profile (pure unit tests only). */
  eligibleProfileIds: Set<string> | null;
}): MeasurementResult {
  const { now, windowStart, windowEnd } = args;
  const eligible = (id: string) => args.eligibleProfileIds === null || args.eligibleProfileIds.has(id);

  // supply
  const activeSupply = new Map<string, number>();
  const staleByKey = new Map<string, number>();
  const oppKeyById = new Map<string, string>();
  for (const o of args.activeOpps) {
    const k = demandPatternKey(patternOf(o));
    oppKeyById.set(o.canonical_id, k);
    activeSupply.set(k, (activeSupply.get(k) ?? 0) + 1);
    const stale =
      ageDays(o.posted_at, now) > C2_CONSTANTS.staleDays &&
      (!o.link_checked_at || ageDays(o.link_checked_at, now) > C2_CONSTANTS.staleDays);
    if (stale) staleByKey.set(k, (staleByKey.get(k) ?? 0) + 1);
  }

  // revealed demand
  const demandWeight = new Map<string, number>();
  const observations = new Map<string, number>();
  const usersByKey = new Map<string, Set<string>>();
  const contributingUsers = new Set<string>();
  const interestedUsersByKey = new Map<string, Set<string>>();
  const swipeKeyByPair = new Map<string, string>();

  let revealedObs = 0;
  for (const s of args.swipes) {
    const key = (s.decision_snapshot?.demandPatternKey as string | undefined) || null;
    if (!key || !parseDemandPatternKey(key)) continue;
    swipeKeyByPair.set(`${s.profile_id}:${s.opportunity_id}`, key);
    if (!eligible(s.profile_id)) continue;
    const bw =
      s.action === 'interested' ? C2_CONSTANTS.signalBaseWeight.swipe_interested :
      s.action === 'passed' ? C2_CONSTANTS.signalBaseWeight.swipe_passed : 0;
    if (bw === 0) continue;
    demandWeight.set(key, (demandWeight.get(key) ?? 0) + bw * recencyWeight(ageDays(s.created_at, now)));
    observations.set(key, (observations.get(key) ?? 0) + 1);
    if (!usersByKey.has(key)) usersByKey.set(key, new Set());
    usersByKey.get(key)!.add(s.profile_id);
    contributingUsers.add(s.profile_id);
    revealedObs++;
    if (s.action === 'interested') {
      if (!interestedUsersByKey.has(key)) interestedUsersByKey.set(key, new Set());
      interestedUsersByKey.get(key)!.add(s.profile_id);
    }
  }

  // application progression — genuine status_changed -> 'applied' only (AMENDMENT 2)
  let progressionObs = 0;
  let progressionUnattributable = 0;
  for (const a of args.appliedEvents) {
    if (!a.applied_event_at) continue;                       // no real transition -> not a signal
    if (!eligible(a.profile_id)) continue;                   // ignore disposable test accounts
    if (new Date(a.applied_event_at) < new Date(windowStart)) continue;
    const key =
      swipeKeyByPair.get(`${a.profile_id}:${a.opportunity_id}`) ||
      oppKeyById.get(a.opportunity_id) ||                     // job still in the catalog
      null;
    if (!key) { progressionUnattributable++; continue; }
    demandWeight.set(key, (demandWeight.get(key) ?? 0)
      + C2_CONSTANTS.signalBaseWeight.application_applied * recencyWeight(ageDays(a.applied_event_at, now)));
    observations.set(key, (observations.get(key) ?? 0) + 1);
    if (!usersByKey.has(key)) usersByKey.set(key, new Set());
    usersByKey.get(key)!.add(a.profile_id);
    contributingUsers.add(a.profile_id);
    progressionObs++;
  }

  // effective supply: active - stale - (active rows already interested-swiped by
  // a profile that demanded that key)
  const alreadySeenByKey = new Map<string, number>();
  for (const s of args.swipes) {
    if (s.action !== 'interested') continue;
    const key = oppKeyById.get(s.opportunity_id);
    if (!key) continue;
    if (interestedUsersByKey.get(key)?.has(s.profile_id)) {
      alreadySeenByKey.set(key, (alreadySeenByKey.get(key) ?? 0) + 1);
    }
  }

  // provisional gaps
  const allKeys = new Set<string>(Array.from(activeSupply.keys()).concat(Array.from(demandWeight.keys())));
  const provisional: RankedGap[] = [];
  for (const key of Array.from(allKeys)) {
    const pattern = parseDemandPatternKey(key);
    if (!pattern) continue;
    const active = activeSupply.get(key) ?? 0;
    const eff = Math.max(0, active - (staleByKey.get(key) ?? 0) - (alreadySeenByKey.get(key) ?? 0));
    const dw = demandWeight.get(key) ?? 0;
    const target = clamp(C2_CONSTANTS.base + C2_CONSTANTS.demandFactor * dw, C2_CONSTANTS.minTarget, C2_CONSTANTS.maxTarget);
    const shortfall = target > 0 ? Math.max(0, target - eff) / target : 0;
    provisional.push({
      pattern, pattern_key: key,
      demand_weight: round(dw), active_supply: active, effective_supply: eff,
      target_supply: target, shortfall: round(shortfall),
      gap_score: round(dw * shortfall), gap_score_status: 'computed',
      observations: observations.get(key) ?? 0,
      distinct_users: usersByKey.get(key)?.size ?? 0,
    });
  }

  const signalsAvailable = [
    ...(revealedObs > 0 ? ['revealed_demand'] : []),
    ...(progressionObs > 0 ? ['application_progression'] : []),
  ];

  const priorKeys = new Set(args.priorPatternKeys);
  const recurring = provisional.filter((g) => g.observations > 0 && priorKeys.has(g.pattern_key)).length;

  const adequacy = assessDatasetAdequacy({
    totalDemandObservations: revealedObs + progressionObs,
    verifiedActiveUsers: contributingUsers.size,
    distinctPatterns: provisional.filter((g) => g.observations > 0).length,
    patterns: provisional.map((g) => ({
      pattern_key: g.pattern_key, observations: g.observations,
      distinct_users: g.distinct_users, active_supply: g.active_supply,
    })),
    recurringPatterns: recurring,
    signalsAvailable,
    hasPriorSnapshots: args.hasPriorSnapshots,
  });

  // THE C2 GAP-SCORE INVARIANT — see the file header.
  //   gap_score is emitted ONLY when `gapRankingAuthorized` (structurally
  //   measurable AND the numeric D3 bar derived+approved). In C2 the D3 bar is
  //   fixed 'deferred', so `withholdReason` is ALWAYS non-null here.
  const withholdReason: Exclude<RankedGap['gap_score_status'], 'computed'> | null =
    adequacy.d3EvidenceStatus !== 'authorized'
      ? 'withheld_d3_evidence_bar_deferred'
      : !adequacy.structurallyMeasurable
        ? 'withheld_dataset_not_structurally_measurable' // AMENDMENT 1 (unreachable in C2)
        : null;

  const rankedGaps: RankedGap[] = withholdReason === null
    ? [...provisional].sort((a, b) => (b.gap_score ?? 0) - (a.gap_score ?? 0))
    : [...provisional]
        .map((g) => ({ ...g, gap_score: null, gap_score_status: withholdReason }))
        .sort((a, b) => b.observations - a.observations); // NOT a gap ranking

  return {
    computed_at: new Date(now).toISOString(),
    window_start: windowStart,
    window_end: windowEnd,
    signals_available: signalsAvailable,
    constants_version: CONSTANTS_VERSION,
    lexicon_version: PATTERN_LEXICON_VERSION,
    verified_active_users: contributingUsers.size,
    distinct_demand_patterns: provisional.filter((g) => g.observations > 0).length,
    total_demand_observations: revealedObs + progressionObs,
    revealed_demand_observations: revealedObs,
    application_progression_observations: progressionObs,
    progression_unattributable: progressionUnattributable,
    structurally_measurable: adequacy.structurallyMeasurable,
    d3_evidence_status: adequacy.d3EvidenceStatus,
    gap_ranking_authorized: adequacy.gapRankingAuthorized,
    dataset_adequate: adequacy.structurallyMeasurable, // migration-013 column (= structural adequacy)
    adequacy_detail: adequacy,
    ranked_gaps: rankedGaps,
    notes:
      `signals_available=[${signalsAvailable.join(', ') || 'none'}]; `
      + `constants=${CONSTANTS_VERSION} (placeholder, demand_factor=0); `
      + `structurally_measurable=${adequacy.structurallyMeasurable}; `
      + `d3_evidence_bar=${adequacy.d3EvidenceStatus}; `
      + `gap_ranking=${adequacy.gapRankingAuthorized ? 'authorized' : 'WITHHELD'}`
      + `${withholdReason ? ` (${withholdReason})` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// I/O wrapper

async function pageAll<T>(
  q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await q(from, from + size - 1);
    if (error) throw new Error(`measure: page read failed: ${JSON.stringify(error)}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

export async function measureDemandGap(
  admin: SupabaseClient,
  opts?: { windowDays?: number; now?: number },
): Promise<MeasurementResult> {
  const now = opts?.now ?? Date.now();
  const windowDays = opts?.windowDays ?? C2_CONSTANTS.defaultWindowDays;
  const windowStart = new Date(now - windowDays * 86_400_000).toISOString();
  const windowEnd = new Date(now).toISOString();

  const activeOpps = await pageAll<MeasureOppRow>((f, t) =>
    admin.from('opportunities')
      .select('canonical_id, title, description, required_skills, remote_type, eligible_countries, experience_requirement, salary_min, salary_currency, posted_at, link_checked_at')
      .eq('status', 'active').range(f, t));

  const swipes = await pageAll<MeasureSwipeRow>((f, t) =>
    admin.from('swipes')
      .select('profile_id, opportunity_id, action, created_at, decision_snapshot')
      .gte('created_at', windowStart).range(f, t));

  // applications that have (currently) progressed past 'interested' — candidates
  const applied = await pageAll<{ id: string; profile_id: string; opportunity_id: string }>((f, t) =>
    admin.from('applications')
      .select('id, profile_id, opportunity_id')
      .in('status', ['applied', 'interview', 'offer', 'archived', 'rejected', 'withdrawn'])
      .range(f, t));

  // ...but only count them if there is a genuine status_changed -> 'applied' event
  const appIds = applied.map((a) => a.id);
  const firstAppliedAt = new Map<string, string>();
  for (let i = 0; i < appIds.length; i += 500) {
    const batch = appIds.slice(i, i + 500);
    if (batch.length === 0) break;
    const rows = await pageAll<{ application_id: string; event_payload: Record<string, unknown>; created_at: string }>((f, t) =>
      admin.from('application_events')
        .select('application_id, event_payload, created_at')
        .eq('event_type', 'status_changed')
        .in('application_id', batch).range(f, t));
    for (const r of rows) {
      if (String(r.event_payload?.toStatus ?? '') !== 'applied') continue;
      const prev = firstAppliedAt.get(r.application_id);
      if (!prev || new Date(r.created_at) < new Date(prev)) firstAppliedAt.set(r.application_id, r.created_at);
    }
  }
  const appliedEvents: MeasureAppliedEvent[] = applied.map((a) => ({
    application_id: a.id, profile_id: a.profile_id, opportunity_id: a.opportunity_id,
    applied_event_at: firstAppliedAt.get(a.id) ?? null,
  }));

  const { data: priorSnap } = await admin
    .from('demand_gap_snapshots')
    .select('ranked_gaps')
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const priorPatternKeys: string[] = Array.isArray((priorSnap as { ranked_gaps?: Array<{ pattern_key: string }> } | null)?.ranked_gaps)
    ? (priorSnap as { ranked_gaps: Array<{ pattern_key: string }> }).ranked_gaps.map((g) => g.pattern_key)
    : [];

  // Real (non-test) profile ids. `remotematch-test-*@example.com` / `@smoke.example`
  // are disposable accounts the test suites create — their swipes/applications
  // must not count as production demand (outcome-lifecycle alone would swamp it).
  const eligibleProfileIds = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`measure: listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      const e = (u.email || '').toLowerCase();
      const isTest = e.includes('remotematch-test-') || e.endsWith('@example.com') || e.includes('@smoke.example');
      if (!isTest) eligibleProfileIds.add(u.id);
    }
    if (users.length < 200) break;
  }

  return computeGapTable({
    now, windowStart, windowEnd, activeOpps, swipes, appliedEvents,
    priorPatternKeys, hasPriorSnapshots: Boolean(priorSnap), eligibleProfileIds,
  });
}
