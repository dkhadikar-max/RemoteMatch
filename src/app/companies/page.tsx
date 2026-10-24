import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { searchCompanies } from '@/lib/companies/catalog';
import { DIRECTORY_PAGE_SIZE, MAX_DIRECTORY_PAGE, parsePageParam } from '@/lib/seo/directory';
import Pagination from '@/components/seo/Pagination';

interface Props {
  searchParams?: Promise<{ q?: string; page?: string }> | { q?: string; page?: string };
}

/**
 * Phase 0 — search only, no browsable "all companies" directory (that would
 * need a GROUP BY / canonical company count PostgREST cannot do without a
 * migration; out of scope — see docs/company-radar-phase0-implementation-
 * plan-2026-10-24.md §2.3). Not yet decided as an SEO landing surface, so
 * deliberately noindex,follow for now — a safety default, not a gap.
 */
const baseMetadata: Metadata = {
  title: { absolute: 'Search Companies | RemoteMatch' },
  description: 'Search for a company to see its currently active remote opportunities on RemoteMatch.',
  robots: { index: false, follow: true },
};

export async function generateMetadata(): Promise<Metadata> {
  return baseMetadata;
}

/** Always on-demand: the underlying catalog changes continuously and this
 *  page has no cache of its own (unlike /remote-jobs' slim index). */
export const dynamic = 'force-dynamic';

export default async function CompanySearchPage({ searchParams }: Props) {
  const resolvedParams = searchParams ? await Promise.resolve(searchParams) : {};
  const q = (typeof resolvedParams.q === 'string' ? resolvedParams.q : '').trim();
  const page = Math.min(Math.max(parsePageParam(resolvedParams.page), 1), MAX_DIRECTORY_PAGE);

  const supabase = createSupabasePublicClient();
  const from = (page - 1) * DIRECTORY_PAGE_SIZE;
  const result =
    q && supabase
      ? await searchCompanies(supabase, q, { from, to: from + DIRECTORY_PAGE_SIZE - 1 })
      : { rows: [], total: 0 };

  const totalPages = Math.max(1, Math.ceil(result.total / DIRECTORY_PAGE_SIZE));

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto space-y-10">
      <header className="space-y-4 max-w-3xl">
        <span className="tag">Company Radar</span>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--ink)]">
          Find a company&apos;s active remote opportunities.
        </h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Search by company name. Results show only currently active opportunities already in the
          RemoteMatch catalog — this is not a company directory.
        </p>
      </header>

      <section className="space-y-4">
        <form method="GET" action="/companies" className="flex gap-2 max-w-2xl">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Search by company name (e.g. Vercel, Supabase, GitLab)..."
              className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] pl-10 pr-4 py-2.5 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--red)] transition-colors shadow-sm"
            />
          </div>
          <button type="submit" className="soft-button primary text-xs !py-2.5 !px-4 shrink-0">
            <span>Search</span>
          </button>
          {q && (
            <Link
              href="/companies"
              className="soft-button secondary text-xs !py-2.5 !px-3 flex items-center gap-1 shrink-0"
              title="Clear search"
            >
              <X size={14} />
              <span>Clear</span>
            </Link>
          )}
        </form>
      </section>

      <section className="space-y-6">
        {!q ? (
          <div className="soft-card p-8 text-center space-y-2">
            <p className="text-sm font-semibold text-[var(--ink)]">Search for a company above.</p>
            <p className="text-sm text-[var(--muted)]">
              Try a name like &ldquo;Vercel&rdquo;, &ldquo;Supabase&rdquo;, or &ldquo;GitLab&rdquo;.
            </p>
          </div>
        ) : result.rows.length === 0 ? (
          <div className="soft-card p-8 text-center space-y-2">
            <p className="text-sm font-semibold text-[var(--ink)]">
              No companies found matching &ldquo;{q}&rdquo;.
            </p>
            <p className="text-sm text-[var(--muted)]">Try a shorter or differently spelled name.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-[var(--line)] pb-4">
              <h2 className="text-xl font-semibold text-[var(--ink)]">
                Results for &ldquo;{q}&rdquo;
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {result.rows.map((row) => (
                <Link
                  key={row.company}
                  href={`/companies/view/${encodeURIComponent(row.company)}`}
                  className="soft-card p-6 flex items-center gap-4 hover:shadow-md transition-shadow border border-[var(--line)] bg-[var(--surface)]"
                >
                  {row.companyLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.companyLogo} alt="" className="h-10 w-10 rounded-lg object-contain border border-[var(--line)] shrink-0" />
                  ) : null}
                  <span className="text-base font-semibold text-[var(--ink)]">{row.company}</span>
                </Link>
              ))}
            </div>
          </>
        )}
        {q && result.rows.length > 0 && (
          <Pagination basePath="/companies" page={page} totalPages={totalPages} query={{ q }} />
        )}
      </section>
    </div>
  );
}
