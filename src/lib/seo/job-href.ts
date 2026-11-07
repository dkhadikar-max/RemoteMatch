/**
 * RemoteMatch — public job URLs: one place that builds them and one that reads them back
 * ==============================================================================
 * A listing's public route id is its `source_id`. For Himalayas and WeWorkRemotely that id is the job's own URL
 * (`https://himalayas.app/companies/{co}/jobs/{job}`, `https://weworkremotely.com/remote-jobs/{slug}`), so the path
 * `/remote-jobs/view/<id>` used to contain slashes: Next answered 308 (it collapses `//` to `/`) and then 404, because
 * `/remote-jobs/view/[id]` is ONE path segment. ~98% of the catalog (37,032 Himalayas + 317 WeWorkRemotely rows) had no reachable
 * detail page, and every sitemap / listing / canonical / IndexNow URL for them was dead.
 *
 * The same defect was fixed for `/match/[jobId]` on 2026-10-14 (src/lib/match/match-href.ts, commit 30a75c9); this applies the
 * same rule to the public route: the id is `encodeURIComponent`-ed into every URL we build and decoded EXACTLY ONCE when read back.
 * Verified on this repo's Next version (14.2.35, built + `next start`): an encoded id routes to the single `[id]` segment, and
 * `params` / `nextUrl.pathname` arrive STILL ENCODED (so the reader must decode), unreserved escapes are normalised by Next, a
 * literal `%2525` is left alone (so decoding twice would corrupt an id), and a malformed escape never reaches app code (Next 400).
 *
 * Ids are never altered — they key swipes, applications and decision snapshots through `canonical_id`.
 */
import { SITE_URL } from '@/lib/site';
import { candidateIdsFromParam } from '@/lib/match/match-href';

export const JOB_VIEW_PATH = '/remote-jobs/view/';

/** The path to a job's public page. The id is encoded, never altered; ids that are already URL-safe come out byte-identical. */
export function jobHref(sourceId: string): string {
  return `${JOB_VIEW_PATH}${encodeURIComponent(sourceId)}`;
}

/** The absolute public URL (canonical tag, og:url, JSON-LD, sitemap, IndexNow). `base` defaults to SITE_URL. */
export function jobUrl(sourceId: string, base: string = SITE_URL): string {
  return `${base}${jobHref(sourceId)}`;
}

/** The raw (still encoded) id segment of a `/remote-jobs/view/<id>[/…]` pathname, or null when the path is not a job-page path. */
export function jobIdSegmentFromPath(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith(JOB_VIEW_PATH)) return null;
  return pathname.slice(JOB_VIEW_PATH.length).split('/')[0];
}

/**
 * Every id a route param could stand for, best first: the param decoded ONCE (what our own links produce), then the param as
 * given (an old link to an id with no special characters, or one with a literal "%"). Ids that need no decoding yield one
 * candidate, so ordinary ids still cost a single lookup.
 */
export function jobIdCandidates(param: unknown): string[] {
  return candidateIdsFromParam(param);
}

/** Resolves a route param through `lookup`, trying the candidates in order; the first hit wins. */
export async function findJobByRouteParam<T>(param: unknown, lookup: (id: string) => Promise<T | null | undefined>): Promise<T | undefined> {
  for (const id of jobIdCandidates(param)) {
    const hit = await lookup(id);
    if (hit) return hit;
  }
  return undefined;
}
