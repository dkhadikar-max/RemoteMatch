/**
 * Resume Intelligence (PR B) — pure safety guards for the live-concurrency harness.
 *
 * Deliberately has NO dependency on `pg` or any database driver, so these functions (and the
 * static tests in resume-concurrency-live-guards-static-suite.ts) can be exercised with zero
 * installs and zero database access — proving the GUARD LOGIC is correct given synthetic inputs.
 * This does NOT prove, and must never be cited as proving, that real PostgreSQL concurrency
 * works — that is a separate, still-UNPROVEN claim (see docs/resume-pr-b-final-audit-2026-10-22.md
 * §2.3) that only resume-concurrency-live-suite.ts, actually run against a disposable database,
 * can establish.
 *
 * SAFETY REWRITE (docs/resume-pr-b-live-concurrency-safety-fixes-2026-10-22.md): the harness
 * previously treated a connection-string hostname denylist as its only safeguard. That is kept
 * here as a cheap, zero-cost secondary check, but it is no longer sufficient on its own — the
 * harness also requires an explicit, exact confirmation string (not just "truthy") AND a live
 * marker row this run's own bootstrap (00-bootstrap.sql) planted in the target database, keyed by
 * a run_tag the operator supplies out-of-band. All three must agree before the harness writes
 * anything.
 */

/** Known-bad substrings — a cheap secondary check, never the sole safeguard. A connection string
 *  NOT containing one of these says nothing about whether the target is actually disposable. */
export const FORBIDDEN_HOST_SUBSTRINGS = ['supabase.co', 'railway', 'paidtest', 'remotematch'];

/** The exact literal an operator must set LIVE_PG_TEST_CONFIRM_DISPOSABLE to. Deliberately an
 *  exact-match sentence, not a boolean-ish "true"/"1"/"yes" — those are too easy to set by habit
 *  or copy-paste without actually having read and meant this specific confirmation. */
export const REQUIRED_CONFIRMATION = 'i-have-verified-this-database-is-disposable-and-empty';

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** Secondary, cheap check only. A pass here is NOT sufficient by itself — see module header. */
export function checkConnectionStringIsSafe(url: string): GuardResult {
  const lower = url.toLowerCase();
  for (const bad of FORBIDDEN_HOST_SUBSTRINGS) {
    if (lower.includes(bad)) {
      return { ok: false, reason: `connection string contains forbidden substring "${bad}" — refusing to target anything that looks like a shared/hosted project` };
    }
  }
  return { ok: true };
}

/** Requires the OPERATOR to have deliberately set this exact string — not a connection-string
 *  label, not a truthy flag. This is the "explicit disposable-database confirmation" the harness
 *  now requires before it will even attempt to connect. */
export function checkConfirmationFlag(value: string | undefined): GuardResult {
  if (value !== REQUIRED_CONFIRMATION) {
    return {
      ok: false,
      reason: `LIVE_PG_TEST_CONFIRM_DISPOSABLE must be set to exactly "${REQUIRED_CONFIRMATION}" (got ${value === undefined ? 'nothing' : JSON.stringify(value)}). This is deliberately not a boolean flag — it must be a conscious, exact confirmation.`,
    };
  }
  return { ok: true };
}

export interface MarkerRow {
  run_tag: string;
  profile_id: string;
}

export interface MarkerCheckResult extends GuardResult {
  profileId?: string;
}

/** The POSITIVE target-identity check: the marker row is written by 00-bootstrap.sql, server-side,
 *  at bootstrap time, keyed by a run_tag the operator chose and passed to BOTH the bootstrap
 *  (`-v run_tag=...`) and the harness (`LIVE_PG_TEST_RUN_TAG`). A database that was never
 *  bootstrapped for this run (wrong target, stale/reused database, typo'd run_tag) has no matching
 *  row — the harness fails closed rather than falling back to any assumption or default id. */
export function checkMarkerMatches(markerRow: MarkerRow | null | undefined, expectedRunTag: string): MarkerCheckResult {
  if (!expectedRunTag || expectedRunTag.trim().length === 0) {
    return { ok: false, reason: 'LIVE_PG_TEST_RUN_TAG is not set — refusing to proceed without an explicit run_tag to verify against the database.' };
  }
  if (!markerRow) {
    return {
      ok: false,
      reason: 'No _resume_pr_b_live_audit_run marker row exists for this run_tag in this database. Either this database was never bootstrapped by 00-bootstrap.sql for this run, or the run_tag is wrong. Refusing to write anything to a database that cannot prove it was prepared for this exact run.',
    };
  }
  if (markerRow.run_tag !== expectedRunTag) {
    return { ok: false, reason: `Marker run_tag ("${markerRow.run_tag}") does not match the expected run_tag ("${expectedRunTag}").` };
  }
  if (!markerRow.profile_id || markerRow.profile_id.trim().length === 0) {
    return { ok: false, reason: 'Marker row has no profile_id — bootstrap did not complete correctly.' };
  }
  return { ok: true, profileId: markerRow.profile_id };
}

/** Runs all three checks in order, short-circuiting (fail-closed) on the first failure — mirrors
 *  exactly what the harness's own startup sequence does, extracted here so it is independently
 *  testable without a database. */
export function runAllPreflightChecks(input: {
  url: string;
  confirmValue: string | undefined;
  markerRow: MarkerRow | null | undefined;
  expectedRunTag: string;
}): GuardResult & { profileId?: string } {
  const hostCheck = checkConnectionStringIsSafe(input.url);
  if (!hostCheck.ok) return hostCheck;

  const confirmCheck = checkConfirmationFlag(input.confirmValue);
  if (!confirmCheck.ok) return confirmCheck;

  const markerCheck = checkMarkerMatches(input.markerRow, input.expectedRunTag);
  if (!markerCheck.ok) return markerCheck;

  return { ok: true, profileId: markerCheck.profileId };
}
