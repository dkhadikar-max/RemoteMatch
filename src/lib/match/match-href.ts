/**
 * Links to the match-detail page — one place that builds them and one that reads them back.
 * ==============================================================================
 * A job's id is `opp-<source>-<source id>`, and for Himalayas and WeWorkRemotely the source id is the job's URL, so the
 * id itself contains slashes ("opp-himalayas-https://himalayas.app/companies/…"). Putting it raw into `/match/${id}`
 * made Next answer with a 308 that collapses `//` to `/` and then 404, because `/match/[jobId]` is ONE path segment.
 * 1,400 of the 1,488 jobs in the live feed (94 %) were unreachable from "View details" / "See why it matches", the swipe
 * toast, the Tracker and the landing page.
 *
 * Fix: the id is URL-encoded into the link (`encodeURIComponent`) and decoded exactly ONCE when it is read back. Verified
 * against the repo's Next version (14.2.35, `next build` + `next start`): an encoded id routes to `/match/[jobId]` and
 * both the server `params.jobId` and the client `useParams().jobId` arrive STILL ENCODED, so decoding once returns the
 * original id. Job ids themselves are never changed (they key swipes, applications and decision snapshots).
 */

/** The link to a job's match page. The id is encoded, never altered. */
export function matchHref(id: string): string {
  return `/match/${encodeURIComponent(id)}`;
}

function decodeOnce(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // a malformed escape (e.g. a literal "%" that was never encoded) — not decodable
  }
}

/**
 * Every id a route param could stand for, best first: the param decoded ONCE (what our own links produce), then the
 * param as given (an old link to an id with no special characters, or one with a literal "%"). Callers pick the first
 * candidate that is a real job id — so a bookmarked `/match/opp-jobicy-153099` keeps working.
 */
export function candidateIdsFromParam(param: unknown): string[] {
  if (typeof param !== 'string' || param.length === 0) return [];
  const decoded = decodeOnce(param);
  const out: string[] = [];
  if (decoded !== null && decoded.length > 0) out.push(decoded);
  if (!out.includes(param)) out.push(param);
  return out;
}

/** Resolves a route param against the ids that exist; null when it matches none. */
export function resolveJobId<T extends { id: string }>(param: unknown, jobs: ReadonlyArray<T>): T | null {
  for (const candidate of candidateIdsFromParam(param)) {
    const hit = jobs.find((j) => j.id === candidate);
    if (hit) return hit;
  }
  return null;
}
