/**
 * RemoteMatch — 48-hour freshness gate (Supply Discovery gate C3)
 * ==============================================================================
 * Per docs/c3-implementation-plan.md §7a. Decides ONLY whether a candidate
 * job is fresh enough to enter the catalog at all for the new ATS sources —
 * it does not expire or delete any existing row, and (per the plan's
 * explicit scope decision) is applied only to Greenhouse/Lever/Ashby
 * candidates in this phase, not retroactively to Remotive/Arbeitnow/Jobicy.
 *
 * No inferred "probably new": an unparseable, missing, or future-dated
 * `posted_at` is rejected outright, never defaulted to "fresh".
 */

export const FRESHNESS_WINDOW_MS = 48 * 3600 * 1000;

export function passesFreshnessGate(postedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!postedAt) return false; // unknown date -> reject

  const posted = new Date(postedAt).getTime();
  if (Number.isNaN(posted)) return false; // unparseable -> reject
  if (posted > now) return false; // future date -> reject

  return now - posted <= FRESHNESS_WINDOW_MS;
}

/**
 * C3-B — the read/publication-time counterpart to passesFreshnessGate()
 * above. Returns the [from, to] bounds for a `posted_at BETWEEN from AND to`
 * style query filter, computed fresh on every call from the CURRENT time —
 * this is what makes a row that WAS fresh at ingestion correctly stop
 * qualifying once it ages past 48h, with no background job or status
 * mutation required. `posted_at IS NULL` is excluded for free: Postgres/
 * PostgREST's `.gte()`/`.lte()` comparisons against NULL evaluate to NULL,
 * which a WHERE clause treats as non-matching — no special-case needed.
 * A future-dated posted_at is excluded by the `to` (upper) bound: without
 * it, a future date would trivially satisfy "posted_at >= now - 48h" and
 * incorrectly appear as maximally fresh.
 *
 * Postgres timestamptz columns are stored/compared in UTC internally, and
 * these bounds are produced via Date/toISOString (also UTC) — there is no
 * separate timezone-normalization step needed as long as every comparison
 * goes through this same function rather than a manually-constructed date
 * string elsewhere.
 */
export function getFreshnessWindowBounds(now: number = Date.now()): { from: string; to: string } {
  return {
    from: new Date(now - FRESHNESS_WINDOW_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}
