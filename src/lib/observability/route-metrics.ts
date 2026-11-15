export interface RouteMetricInput {
  route: string;
  stage: string;
  durationMs: number;
  outcome: 'success' | 'found' | 'not_found' | 'timeout' | 'error';
  resultCount?: number;
}

/**
 * Structured, low-cardinality route-stage telemetry.
 * Never include request IDs, source IDs, search text, user data, or exception
 * messages: the metric is for latency/error aggregation, not request tracing.
 */
export function recordRouteMetric(metric: RouteMetricInput): void {
  console.info('[route-metric]', JSON.stringify({
    route: metric.route,
    stage: metric.stage,
    durationMs: Math.max(0, Math.round(metric.durationMs)),
    outcome: metric.outcome,
    ...(metric.resultCount === undefined ? {} : { resultCount: metric.resultCount }),
  }));
}
