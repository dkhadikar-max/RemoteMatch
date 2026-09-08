/**
 * RemoteMatch — Dataset-adequacy assessment (Additional Supply Discovery, C2)
 * ==============================================================================
 * C2's core deliverable. A PURE function over the measurement output.
 *
 * TWO SEPARATE QUESTIONS — deliberately NOT collapsed into one boolean:
 *
 *   1. structurallyMeasurable — do the mechanics have enough data to RUN the
 *      measurement at all? Structural facts only: is there any demand signal,
 *      any signal source with data, any pattern to rank, a prior window so
 *      recurrence is defined. Each is `blocking: true|false` from the fact
 *      itself — no invented number.
 *
 *   2. d3EvidenceStatus — is the numeric D3 evidence bar DERIVED and APPROVED?
 *      In C2 this is ALWAYS 'deferred'. The spec (§5, §17) requires those
 *      thresholds to be derived from the observed C2/C4 distribution in a
 *      SEPARATE, separately-approved gate. C2 only records the observed values
 *      of the metrics that bar will threshold (DEFERRED_D3_THRESHOLD_METRICS).
 *
 * gapRankingAuthorized = structurallyMeasurable && d3EvidenceStatus==='authorized'.
 * In C2 this is ALWAYS false, so `measure.ts` ALWAYS withholds `gap_score`. A
 * future run may become structurallyMeasurable while d3EvidenceStatus stays
 * 'deferred' — `gap_score` STAYS withheld. The invariant this enforces:
 *
 *     no derived+approved D3 thresholds  ->  no gap_score  ->  no demand-gap
 *     ranking  ->  no discovery trigger  ->  no shortage claim
 *
 * Nothing in C2 sets d3EvidenceStatus to 'authorized'. This result must NOT be
 * read as a D3 authorization.
 */

/** The metrics a future D3 evidence bar will threshold. C2 records their
 *  observed values so the thresholds can be derived from accumulated
 *  demand_gap_snapshots history — it does not assign them values now. */
export const DEFERRED_D3_THRESHOLD_METRICS = [
  'verified_active_users',
  'observations_on_top_pattern',
  'distinct_users_on_top_pattern',
  'recurring_pattern_count',
  'catalog_coverage',
] as const;

/** C2 never advances this past 'deferred'. A future gate that derives AND
 *  approves the numeric bar is the only thing that may set 'authorized'. */
export type D3EvidenceStatus = 'deferred' | 'authorized';

/** Fixed for C2. Not derived from data, not an argument — the numeric D3 bar is
 *  a separate, later, separately-approved gate. */
const D3_EVIDENCE_STATUS_IN_C2: D3EvidenceStatus = 'deferred';

export interface AdequacyInput {
  totalDemandObservations: number;
  verifiedActiveUsers: number;
  distinctPatterns: number;
  /** ranked_gaps entries; we look at the top-observed one */
  patterns: Array<{ pattern_key: string; observations: number; distinct_users: number; active_supply: number }>;
  recurringPatterns: number;          // patterns seen this AND a prior window
  signalsAvailable: string[];          // of the 4 spec sources — which had data
  hasPriorSnapshots: boolean;
}

export interface AdequacyCriterion {
  name: string;
  kind: 'structural' | 'deferred_threshold';
  observed: number | string;
  /** structural: the fixed rule text. deferred: the literal string 'deferred'. */
  rule: string;
  /** structural: true = currently blocks structural measurability.
   *  deferred: null (not a gate — observed value only). */
  blocking: boolean | null;
  detail?: string;
}

export interface AdequacyResult {
  /** (1) mechanics have enough data to RUN the measurement — structural facts
   *  only. NOT an authorization to rank. */
  structurallyMeasurable: boolean;
  /** (2) the numeric D3 evidence bar. ALWAYS 'deferred' in C2. */
  d3EvidenceStatus: D3EvidenceStatus;
  /** `gap_score` may be emitted ONLY when this is true.
   *  = structurallyMeasurable && d3EvidenceStatus === 'authorized'.
   *  ALWAYS false in C2. */
  gapRankingAuthorized: boolean;
  method: string;
  criteria: AdequacyCriterion[];
  deferred_threshold_metrics: readonly string[];
  summary: string;
}

export function assessDatasetAdequacy(input: AdequacyInput): AdequacyResult {
  const top = [...input.patterns].sort((a, b) => b.observations - a.observations)[0];
  const catalogCoverage = input.patterns.reduce((n, p) => n + p.active_supply, 0);
  const missingSources = ['active_user_requirement', 'search_filter_activity']
    .filter((s) => !input.signalsAvailable.includes(s));

  const structural: AdequacyCriterion[] = [
    {
      name: 'has_any_demand_signal',
      kind: 'structural',
      observed: input.totalDemandObservations,
      rule: 'at least one demand observation exists',
      blocking: input.totalDemandObservations === 0,
      detail: input.totalDemandObservations === 0 ? 'no demand signal of any kind in the window' : undefined,
    },
    {
      name: 'has_a_demand_signal_source',
      kind: 'structural',
      observed: `${input.signalsAvailable.length}/4 (${input.signalsAvailable.join(', ') || 'none'})`,
      rule: 'at least one of the 4 spec signal sources has server-side data',
      blocking: input.signalsAvailable.length === 0,
      detail: missingSources.length
        ? `${missingSources.join(' & ')} have NO server-side source (architectural — separate gates)`
        : undefined,
    },
    {
      name: 'has_patterns_to_rank',
      kind: 'structural',
      observed: input.distinctPatterns,
      rule: 'at least one demanded pattern is observed',
      blocking: input.distinctPatterns === 0,
    },
    {
      name: 'recurrence_is_measurable',
      kind: 'structural',
      observed: input.hasPriorSnapshots ? 'yes' : 'no',
      rule: 'a prior measurement window exists, so demand recurrence can be assessed',
      blocking: !input.hasPriorSnapshots,
      detail: input.hasPriorSnapshots ? undefined : 'first run — recurrence unmeasurable until a 2nd window',
    },
  ];

  const deferred: AdequacyCriterion[] = [
    { name: 'verified_active_users', kind: 'deferred_threshold', observed: input.verifiedActiveUsers, rule: 'deferred', blocking: null },
    { name: 'observations_on_top_pattern', kind: 'deferred_threshold', observed: top?.observations ?? 0, rule: 'deferred', blocking: null, detail: top ? `pattern ${top.pattern_key}` : 'no patterns' },
    { name: 'distinct_users_on_top_pattern', kind: 'deferred_threshold', observed: top?.distinct_users ?? 0, rule: 'deferred', blocking: null },
    { name: 'recurring_pattern_count', kind: 'deferred_threshold', observed: input.hasPriorSnapshots ? input.recurringPatterns : 'n/a (first run)', rule: 'deferred', blocking: null },
    { name: 'catalog_coverage', kind: 'deferred_threshold', observed: catalogCoverage, rule: 'deferred', blocking: null },
  ];

  const criteria = [...structural, ...deferred];
  const blockers = structural.filter((c) => c.blocking === true).map((c) => c.name);
  const structurallyMeasurable = blockers.length === 0;
  const d3EvidenceStatus = D3_EVIDENCE_STATUS_IN_C2;
  const gapRankingAuthorized = structurallyMeasurable && (d3EvidenceStatus as D3EvidenceStatus) === 'authorized';

  const structuralLine = structurallyMeasurable
    ? 'structural adequacy: MEASURABLE (no blocking structural facts)'
    : `structural adequacy: INSUFFICIENT (blocking: ${blockers.join(', ')})`;

  return {
    structurallyMeasurable,
    d3EvidenceStatus,
    gapRankingAuthorized,
    method:
      'Two independent questions. (1) structural measurability — facts only, no '
      + 'invented number. (2) the numeric D3 evidence bar — DEFERRED in C2, to be '
      + 'derived from demand_gap_snapshots history in a separate, separately-'
      + 'approved gate (spec §5/§17). gap_score is emitted ONLY when BOTH clear; '
      + 'in C2 it never is. This result must NOT be read as a D3 authorization.',
    criteria,
    deferred_threshold_metrics: DEFERRED_D3_THRESHOLD_METRICS,
    summary:
      `${structuralLine}. `
      + `D3 evidence bar: ${d3EvidenceStatus} (numeric thresholds not derived/approved). `
      + `gap ranking: ${gapRankingAuthorized ? 'authorized' : 'WITHHELD'} — `
      + 'gap_score is null, no discovery ranking, no shortage claim.',
  };
}
