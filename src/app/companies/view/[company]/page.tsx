import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, MapPin, ExternalLink } from 'lucide-react';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { getOpportunitiesByExactCompany, isValidCompanyName, labelForSource } from '@/lib/companies/catalog';

interface Props {
  params: Promise<{ company: string }>;
}

/**
 * Live-catalog-dependent, exactly like /remote-jobs/view/[id] — generateStaticParams
 * returns [] deliberately, every id renders on demand, dynamic is forced.
 */
export const dynamic = 'force-dynamic';

export async function generateStaticParams() {
  return [];
}

function decodeCompanyParam(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isValidCompanyName(decoded) ? decoded : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { company } = await params;
  const name = decodeCompanyParam(company);
  if (!name) return {};
  return {
    title: { absolute: `${name} — Remote Jobs on RemoteMatch | RemoteMatch` },
    description: `Currently active remote opportunities at ${name} on RemoteMatch.`,
    // Phase 0 — not yet decided as an indexed SEO surface; noindex,follow for now.
    robots: { index: false, follow: true },
  };
}

export default async function CompanyProfilePage({ params }: Props) {
  const { company } = await params;
  const name = decodeCompanyParam(company);
  if (!name) notFound();

  const supabase = createSupabasePublicClient();
  const result = supabase
    ? await getOpportunitiesByExactCompany(supabase, name)
    : { rows: [], total: 0 };

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto space-y-10">
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">Home</Link>
        <span>/</span>
        <Link href="/companies" className="hover:text-[var(--ink)] transition-colors">Companies</Link>
        <span>/</span>
        <span className="text-[var(--ink)] font-medium">{name}</span>
      </nav>

      <header className="space-y-4">
        {/* company_logo is set per-row by the source, not a company-level
            fact — different active postings for the same exact-match
            company CAN carry different logo URLs. This arbitrarily shows
            whichever the newest (first, by posted_at desc) row has set;
            that is a deliberate, accepted Phase 0 simplification. */}
        <div className="flex items-center gap-4">
          {result.rows[0]?.companyLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.rows[0].companyLogo}
              alt=""
              className="h-14 w-14 rounded-xl object-contain border border-[var(--line)]"
            />
          ) : null}
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">{name}</h1>
        </div>
        <p className="text-sm text-[var(--muted)]">
          {result.total > 0
            ? `${result.total} open role${result.total === 1 ? '' : 's'} currently listed on RemoteMatch.`
            : 'No active opportunities currently listed for this company on RemoteMatch.'}
        </p>

        {/* Phase 0 has no source for these fields — rendered as explicitly
            unknown rather than inferred or omitted-and-implied. See
            docs/company-radar-phase0-readiness-report-2026-10-24.md §Blocker 3. */}
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          {[
            ['Website', 'Not available'],
            ['Industry', 'Not available'],
            ['Headquarters', 'Not available'],
            ['Verification status', 'Not available'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className="font-medium text-[var(--ink)]">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <section className="space-y-6">
        {result.rows.length === 0 ? (
          <div className="soft-card p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-[var(--ink)]">No active opportunities right now.</p>
            <p className="text-sm text-[var(--muted)]">
              This company may have listed roles before, or may list new ones later — check back, or
              search for other companies.
            </p>
            <div className="pt-2">
              <Link href="/companies" className="soft-button secondary text-sm">
                Search other companies
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {result.rows.map((opp, idx) => (
              <article
                key={`${opp.officialUrl}-${idx}`}
                className="soft-card p-6 flex flex-col justify-between border border-[var(--line)] bg-[var(--surface)]"
              >
                <div className="space-y-3">
                  <h2 className="text-base sm:text-lg font-semibold text-[var(--ink)]">{opp.title}</h2>
                  <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs sm:text-sm text-[var(--muted)]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={13} className="text-[var(--muted)]" />
                      {opp.remoteType}
                    </span>
                  </div>
                  {opp.requiredSkills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {opp.requiredSkills.slice(0, 4).map((tag, i) => (
                        <span key={i} className="rounded-md bg-[var(--surface-soft)] px-2.5 py-1 text-xs text-[var(--muted)] border border-[var(--line)]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-5 pt-4 border-t border-[var(--line)]">
                  {/* Plain outbound link, no apply-click tracking — Phase 0
                      deliberately does not integrate funnel instrumentation;
                      that is a separate, later enhancement if ever approved. */}
                  <a
                    href={opp.officialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-[var(--red)] hover:underline inline-flex items-center gap-1"
                  >
                    <span>{labelForSource(opp.source)}</span>
                    <ExternalLink size={13} />
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
        <div>
          <Link href="/companies" className="text-sm font-medium text-[var(--red)] hover:underline inline-flex items-center gap-1">
            <span>Search other companies</span>
            <ArrowRight size={13} />
          </Link>
        </div>
      </section>
    </div>
  );
}
