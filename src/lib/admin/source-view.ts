const STALE_HOURS = 72; // a source untouched this long, while "active", reads as stale — a display heuristic only, not a DB flag

export interface SourceRowInput {
  status: string;
  consecutive_fetch_failures: number;
  last_fetch_attempt_at: string | null;
}

export type SourceHealth = 'healthy' | 'failing' | 'stale' | 'never_run';

/**
 * Admin view of a `supply_sources` row: adds the display health and reports the lifetime-ingested counter as
 * `null` ("not tracked"). `supply_sources.lifetime_jobs_ingested` is never written by any code path (it only has its
 * migration-012 default of 0), so passing it through would show "0" as if it were a real count. Any value on the
 * input row is intentionally ignored.
 */
export function toSourceView<T extends SourceRowInput>(row: T, now: number): Omit<T, 'lifetime_jobs_ingested'> & { lifetime_jobs_ingested: number | null; health: SourceHealth } {
  const lastAttempt = row.last_fetch_attempt_at ? new Date(row.last_fetch_attempt_at).getTime() : null;
  const staleHours = lastAttempt ? (now - lastAttempt) / (3600 * 1000) : null;
  let health: SourceHealth = 'never_run';
  if (row.consecutive_fetch_failures > 0) health = 'failing';
  else if (staleHours !== null && staleHours > STALE_HOURS && row.status === 'active') health = 'stale';
  else if (lastAttempt !== null) health = 'healthy';
  return { ...row, lifetime_jobs_ingested: null, health };
}
