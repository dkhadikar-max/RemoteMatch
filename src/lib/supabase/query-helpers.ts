/**
 * Shared Supabase/PostgREST query helpers.
 * ==============================================================================
 * Two failure classes these exist to make impossible to write by accident:
 *
 * 1. SWALLOWED ERRORS. supabase-js does NOT throw on a failed query — it
 *    resolves `{ data: null, error }`. Code that destructures only `data`
 *    (`const { data } = await ...; data ?? []`) turns a missing table, a bad
 *    column, or an outage into a plain zero/empty result. `must()` /
 *    `mustCount()` turn that into a thrown QueryError instead.
 *
 * 2. SILENT ROW TRUNCATION. PostgREST caps any un-ranged read at 1,000 rows
 *    and returns them with no error and no indication anything was cut off
 *    (verified against this project: a plain select of active
 *    `opportunities` returns exactly 1000 of 9,883). `fetchAllRows()` reads
 *    in id-keyset pages until an empty page, so a result is either
 *    complete or a thrown error — never a quiet sample.
 */

export interface PgError {
  message: string;
  code?: string;
}

export class QueryError extends Error {
  readonly label: string;
  readonly code?: string;

  constructor(label: string, message: string, code?: string) {
    super(`${label}: ${message}`);
    this.name = 'QueryError';
    this.label = label;
    this.code = code;
  }
}

/** Throws QueryError if the query failed; otherwise returns the result
 *  untouched (so `.data` / `.count` remain usable, and are trustworthy). */
export function must<R extends { error: PgError | null }>(res: R, label: string): R {
  if (res.error) throw new QueryError(label, res.error.message, res.error.code);
  return res;
}

/** For `{ count: 'exact', head: true }` queries. A null count with no error
 *  is treated as a failure, never silently as zero. */
export function mustCount(res: { count: number | null; error: PgError | null }, label: string): number {
  must(res, label);
  if (res.count === null) throw new QueryError(label, 'the query returned no count');
  return res.count;
}

/**
 * True when the database reports the relation itself is absent (an
 * unapplied migration) — as opposed to a transient or permission failure.
 * PostgREST reports PGRST205 ("Could not find the table ... in the schema
 * cache"); a direct Postgres path reports 42P01.
 */
export function isMissingRelation(err: { message: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'PGRST205' || err.code === '42P01' || /schema cache|does not exist/i.test(err.message);
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 500_000;

/**
 * Reads EVERY row a query would match, in id-keyset pages.
 *
 * `fetchPage` must build the same filtered query each call, ordered by `id`
 * ascending, limited to `pageSize`, and — when `afterId` is non-null — add
 * `.gt('id', afterId)`. The selected columns must include `id`.
 *
 * Termination is on an EMPTY page, deliberately not on `rows.length <
 * pageSize`: if the server's row cap were ever lower than `pageSize`, a
 * short page would otherwise look like "the end" and quietly truncate again.
 * The cost is one extra (empty) request per read.
 *
 * Keyset (not offset) paging so rows inserted or deleted mid-read by the
 * ingestion job cannot cause skipped or duplicated rows.
 */
export async function fetchAllRows<T extends { id: string }>(
  fetchPage: (afterId: string | null, pageSize: number) => PromiseLike<{ data: unknown; error: PgError | null }>,
  opts: { label: string; pageSize?: number; maxRows?: number }
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const out: T[] = [];
  let afterId: string | null = null;

  for (;;) {
    const res = await fetchPage(afterId, pageSize);
    if (res.error) throw new QueryError(opts.label, res.error.message, res.error.code);
    const rows = (res.data ?? []) as T[];
    if (rows.length === 0) return out;
    out.push(...rows);
    afterId = rows[rows.length - 1].id;
    if (out.length >= maxRows) {
      throw new QueryError(opts.label, `read reached the ${maxRows}-row safety limit — refusing to continue`);
    }
  }
}
