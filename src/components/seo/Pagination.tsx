import React from 'react';
import Link from 'next/link';

interface PaginationProps {
  /** Path without a query string, e.g. "/remote-jobs" or "/remote-jobs/design". */
  basePath: string;
  page: number;
  totalPages: number;
  /** Extra query params to preserve on every link (e.g. { q: 'react' }). */
  query?: Record<string, string>;
}

function hrefFor(basePath: string, page: number, query: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Page numbers to show: first, last, and a window around the current page. */
export function pageWindow(page: number, totalPages: number): Array<number | 'gap'> {
  const wanted = new Set<number>([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
  const nums = Array.from(wanted).filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('gap');
    out.push(n);
  });
  return out;
}

export default function Pagination({ basePath, page, totalPages, query }: PaginationProps) {
  if (totalPages <= 1) return null;
  const cls = 'rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors';
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-2 pt-2">
      {page > 1 && (
        <Link href={hrefFor(basePath, page - 1, query)} rel="prev" className={cls}>
          ← Previous
        </Link>
      )}
      {pageWindow(page, totalPages).map((n, i) =>
        n === 'gap' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-[var(--muted)]">
            …
          </span>
        ) : n === page ? (
          <span key={n} aria-current="page" className="rounded-lg bg-[var(--red)] px-3 py-1.5 text-xs font-semibold text-white">
            {n}
          </span>
        ) : (
          <Link key={n} href={hrefFor(basePath, n, query)} className={cls}>
            {n}
          </Link>
        )
      )}
      {page < totalPages && (
        <Link href={hrefFor(basePath, page + 1, query)} rel="next" className={cls}>
          Next →
        </Link>
      )}
    </nav>
  );
}
