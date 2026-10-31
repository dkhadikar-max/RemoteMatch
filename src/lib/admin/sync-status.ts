/**
 * Sync Health classification for the C1 aggregators + C3 ATS pipeline (pure, unit-tested).
 *
 * The app cannot read the Railway schedule, so it can only OBSERVE: when the last two runs were ~6h apart there is
 * evidence of a recurring schedule; otherwise there is none. The previous version labelled a pipeline "Healthy" purely
 * because the newest run was recent — even when the last two runs were 700h apart (a manual run after the cron was
 * switched off). A recent run is not a schedule.
 *
 *  recurring evidence + fresh run            → healthy
 *  recurring evidence + one missed run       → degraded
 *  recurring evidence + older                → stale
 *  NO recurring evidence + recent run        → recent_activity   ("Recent activity (no schedule)")
 *  NO recurring evidence + older / no run    → not_scheduled     (run age is shown separately)
 *  no run ever observed                      → no_evidence
 */
export const EXPECTED_INTERVAL_HOURS = 6;
/** A run's newest-activity timestamps jitter by minutes; a 6h cron is "observed" within this many hours of 6h. */
export const CADENCE_TOLERANCE_HOURS = 1;
export const HEALTHY_MAX_AGE_HOURS = EXPECTED_INTERVAL_HOURS + 1;
export const DEGRADED_MAX_AGE_HOURS = EXPECTED_INTERVAL_HOURS * 2 + 1;

/**
 * One sync run touches its rows' `last_seen_in_feed_at` over a few minutes (a full run is >5 min). Activity older than
 * this, measured back from the newest timestamp, therefore belongs to an EARLIER run — that is how a "previous run" is
 * told apart from the tail of the latest one. A run split by this rule can never fake a second run, which is what keeps
 * a first-ever sync from looking like a recurring schedule.
 */
export const RUN_SEPARATION_MINUTES = 90;

/** Upper bound (exclusive) for the "previous run" lookup: activity strictly older than this predates the latest run. */
export function previousRunCutoffIso(latestIso: string): string {
  return new Date(new Date(latestIso).getTime() - RUN_SEPARATION_MINUTES * 60 * 1000).toISOString();
}

const HOUR_MS = 3600 * 1000;
const roundTenth = (n: number) => Math.round(n * 10) / 10;

/**
 * Turns the two observed timestamps (newest activity; newest activity older than previousRunCutoffIso(latest)) into
 * the two numbers classifyFeedPipeline needs. Zero runs → both null; one run → ageHours only; two or more →
 * both, the interval being the gap between the last two runs.
 */
export function observeFeedRuns(input: {
  latest: string | null;
  previous: string | null;
  nowMs: number;
}): { ageHours: number | null; observedIntervalHours: number | null } {
  const { latest, previous, nowMs } = input;
  if (!latest) return { ageHours: null, observedIntervalHours: null };
  const latestMs = new Date(latest).getTime();
  return {
    ageHours: (nowMs - latestMs) / HOUR_MS,
    observedIntervalHours: previous ? roundTenth((latestMs - new Date(previous).getTime()) / HOUR_MS) : null,
  };
}

export type FeedPipelineStatus = 'healthy' | 'degraded' | 'stale' | 'no_evidence' | 'not_scheduled' | 'recent_activity';

export interface FeedPipelineClassification {
  status: FeedPipelineStatus;
  /** True only when a recurring cadence was observed AND the pipeline is currently on it (healthy/degraded). */
  enabled: boolean;
  recurring: boolean;
  cadence: string;
}

export function classifyFeedPipeline(input: {
  /** Hours since the newest run, or null when no run was ever observed. */
  ageHours: number | null;
  /** Hours between the last two observed runs, or null when only one run exists. */
  observedIntervalHours: number | null;
}): FeedPipelineClassification {
  const { ageHours, observedIntervalHours } = input;
  const recurring =
    observedIntervalHours !== null && Math.abs(observedIntervalHours - EXPECTED_INTERVAL_HOURS) <= CADENCE_TOLERANCE_HOURS;

  const cadence = recurring
    ? `every ~${EXPECTED_INTERVAL_HOURS}h (observed)`
    : observedIntervalHours === null
      ? 'not scheduled — only one run observed, no recurring cadence'
      : `not scheduled — no recurring cadence observed (last two runs were ${observedIntervalHours}h apart, a ${EXPECTED_INTERVAL_HOURS}h schedule would be ~${EXPECTED_INTERVAL_HOURS}h)`;

  if (ageHours === null) return { status: 'no_evidence', enabled: false, recurring: false, cadence: 'not scheduled — no run observed' };

  if (!recurring) {
    return {
      status: ageHours <= HEALTHY_MAX_AGE_HOURS ? 'recent_activity' : 'not_scheduled',
      enabled: false,
      recurring: false,
      cadence,
    };
  }
  const status: FeedPipelineStatus =
    ageHours <= HEALTHY_MAX_AGE_HOURS ? 'healthy' : ageHours <= DEGRADED_MAX_AGE_HOURS ? 'degraded' : 'stale';
  return { status, enabled: status === 'healthy' || status === 'degraded', recurring: true, cadence };
}
