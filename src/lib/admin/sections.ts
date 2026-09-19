import { NextResponse } from 'next/server';
import { QueryError } from '@/lib/supabase/query-helpers';

/**
 * Admin-console response helpers: a panel that cannot be computed must be
 * reported as FAILED with a reason, never rendered as zero.
 */
export interface FailedSection {
  section: string;
  message: string;
}

/**
 * Runs independent sections in parallel. Each section either resolves to its
 * value or throws (typically a QueryError from must()/fetchAllRows()); a
 * throw in one section never affects the others.
 */
export async function runSections<T extends Record<string, () => Promise<unknown>>>(
  defs: T
): Promise<{ values: { [K in keyof T]?: Awaited<ReturnType<T[K]>> }; failed: FailedSection[] }> {
  const keys = Object.keys(defs) as (keyof T & string)[];
  const settled = await Promise.allSettled(keys.map((k) => defs[k]()));

  const values: { [K in keyof T]?: Awaited<ReturnType<T[K]>> } = {};
  const failed: FailedSection[] = [];
  settled.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled') {
      (values as Record<string, unknown>)[key] = result.value;
    } else {
      const reason = result.reason;
      failed.push({ section: key, message: reason instanceof Error ? reason.message : String(reason) });
    }
  });
  return { values, failed };
}

/** Maps a thrown QueryError to an explicit HTTP 500 that names the failure.
 *  Returns null for anything else so the caller can fall through to its own
 *  generic handling. */
export function queryErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof QueryError) {
    return NextResponse.json(
      { error: 'Database query failed.', detail: err.message, code: err.code ?? null },
      { status: 500 }
    );
  }
  return null;
}

/** HTTP 500 carrying whatever DID compute, so the UI can render healthy
 *  panels and mark only the failed ones. Deliberately not a 200: a partially
 *  failed dashboard must never look healthy to a script or a monitor. */
export function partialFailureResponse(failed: FailedSection[], partial: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    {
      error: `${failed.length} section${failed.length === 1 ? '' : 's'} failed to load.`,
      failedSections: failed,
      partial,
    },
    { status: 500 }
  );
}
