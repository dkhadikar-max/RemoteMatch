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
