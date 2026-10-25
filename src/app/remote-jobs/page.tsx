import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Briefcase,
  MapPin,
  DollarSign,
  Search,
  Filter,
  X,
} from 'lucide-react';
import { notFound } from 'next/navigation';
import {
  SEO_CATEGORIES,
  buildBreadcrumbSchema,
  buildJobPostingSchema,
  formatSalaryRange,
  SeoFaqItem,
} from '@/lib/seo/data';
import { loadHubPage, loadSearchPage, parsePageParam } from '@/lib/seo/directory';
import Pagination from '@/components/seo/Pagination';
import { SITE_URL } from '@/lib/site';

interface Props {
  searchParams?: Promise<{ q?: string; page?: string }> | { q?: string; page?: string };
}

const baseMetadata: Metadata = {
  // `absolute` bypasses the root layout's '%s | RemoteMatch' title template
  // (which would otherwise render "...RemoteMatch | RemoteMatch") — same
  // fix as src/app/admin/layout.tsx, same reason: this title already ends
  // with its own "| RemoteMatch" suffix.
  title: { absolute: 'Remote Jobs Directory — Curated Roles Matched to Your Experience | RemoteMatch' },
  description:
    'Browse verified remote software engineering, product, design, and data jobs. Transparent salaries, verified remote scope, and match insights before you apply.',
  alternates: {
    canonical: `${SITE_URL}/remote-jobs`,
  },
  openGraph: {
    title: 'Remote Jobs Directory | RemoteMatch',
    description:
      'Browse verified remote jobs across engineering, design, product, and marketing. Know your chances before you apply.',
    url: `${SITE_URL}/remote-jobs`,
    type: 'website',
  },
};

// Deep pages and search results are not worth indexing as landing pages — every
// job on them is already in the sitemap — but their links should still be followed.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const resolved = searchParams ? await Promise.resolve(searchParams) : {};
  const hasSearch = typeof resolved.q === 'string' && resolved.q.trim() !== '';
  if (parsePageParam(resolved.page) > 1 || hasSearch) {
    return { ...baseMetadata, robots: { index: false, follow: true } };
  }
  return baseMetadata;
}

export default async function RemoteJobsDirectoryPage({ searchParams }: Props) {
  const resolvedParams = searchParams ? await Promise.resolve(searchParams) : {};
  const q = resolvedParams.q;
  const searchQuery = (typeof q === 'string' ? q : '')?.trim() || '';
  // Bounded reads: a cached slim index + one page of rows (or a database-side
  // search with LIMIT/OFFSET) — never the whole catalog. See src/lib/seo/directory.ts.
  const hub = searchQuery
    ? await loadSearchPage(searchQuery, resolvedParams.page)
    : await loadHubPage(null, resolvedParams.page);
  if (hub?.outOfRange) notFound();
  const jobs = hub?.jobs ?? [];
  const totalJobs = hub?.total ?? 0;
  const currentPage = hub?.page ?? 1;
  const totalPages = hub?.totalPages ?? 1;
  const pageOffset = (currentPage - 1) * (hub?.pageSize ?? jobs.length);

  const breadcrumbsSchema = buildBreadcrumbSchema([
    { name: 'Home', url: SITE_URL },
    { name: 'Remote Jobs', url: `${SITE_URL}/remote-jobs` },
  ]);

  const jsonLdItemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Remote Jobs Directory',
    description: 'Vetted remote job listings curated by RemoteMatch.',
    numberOfItems: totalJobs,
    itemListElement: jobs
      .map((job, index) => {
        const posting = buildJobPostingSchema(job);
        if (!posting) return null;
        return {
          '@type': 'ListItem',
          position: pageOffset + index + 1,
          item: posting,
        };
      })
      .filter(Boolean),
  };

  const directoryFaqs: SeoFaqItem[] = [
    {
      q: 'What is RemoteMatch?',
      directAnswer: 'RemoteMatch is a remote job search platform that helps professionals discover remote jobs matched to their experience and preferences.',
      explanation: 'Our platform explains why a role fits, identifies what may be missing, and tracks your applications from initial click to formal offer.',
      linkHref: '/guide/how-remote-matching-works',
      linkText: 'Learn more about RemoteMatch matching',
    },
    {
      q: 'How do I find remote jobs that match my experience?',
      directAnswer: 'You can browse active listings in this directory or create a profile to calculate personalized fit scores for every role.',
      explanation: 'RemoteMatch evaluates your stack, seniority scope, and timezone overlap against employer requirements so you focus on high-probability opportunities.',
      linkHref: '/onboarding',
      linkText: 'Create a free profile to calculate your fit',
    },
    {
      q: 'How does RemoteMatch match jobs to experience?',
      directAnswer: 'We analyze four factual dimensions: role alignment, technical stack depth, seniority scope, and timezone overlap.',
      explanation: 'This structured comparison highlights verified strengths and flags prerequisites that need clarification before you submit an application.',
      linkHref: '/guide/evaluate-remote-job-requirements',
      linkText: 'Read our requirements evaluation guide',
    },
    {
      q: 'Can I see why a remote job matches me?',
      directAnswer: 'Yes. On every job card and match view, RemoteMatch shows why the role fits and what skills or context might be missing.',
      explanation: 'This transparency helps you address potential concerns in your proposal note or prioritize roles with the strongest alignment.',
      linkHref: '/feed',
      linkText: 'Explore the interactive job match deck',
    },
    {
      q: 'Are all jobs on RemoteMatch 100% remote?',
      directAnswer: 'Yes. Every listed role is verified remote with transparent geographic eligibility (Worldwide, US/Canada, or Europe/UK).',
      explanation: 'We exclude hybrid roles requiring physical office attendance and clearly state timezone overlap requirements upfront.',
      linkHref: '/remote-jobs/worldwide',
      linkText: 'Browse worldwide remote listings',
    },
    {
      q: 'How often are job listings updated?',
      directAnswer: 'Job listings are verified daily. When positions close, they are removed from the active directory and sitemap.',
      explanation: 'This guarantees candidates only spend time applying to live positions actively accepting new applicants.',
      linkHref: '/remote-jobs',
      linkText: 'Explore freshly verified remote jobs',
    },
  ];

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto space-y-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdItemList) }}
      />

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">
          Home
        </Link>
        <span>/</span>
        <span className="text-[var(--ink)] font-medium">Remote Jobs</span>
      </nav>

      {/* AEO Top-of-Page Answer Architecture */}
      <header className="space-y-4 max-w-3xl">
        <span className="tag">Remote Job Directory</span>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--ink)]">
          Remote jobs matched to your experience.
        </h1>
        <div className="soft-card p-5 bg-[var(--surface-soft)] border border-[var(--line)]">
          <p className="text-sm font-medium text-[var(--ink)] leading-relaxed">
            RemoteMatch helps professionals discover remote jobs matched to their experience and preferences, understand why a job fits, identify what may be missing, and track applications from application to offer.
          </p>
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Every position below is verified remote with transparent compensation, explicit geographic hiring boundaries, and direct employer application links.
          </p>
        </div>
      </header>

      {/* Real Search Experience (Supports WebSite SearchAction) */}
      <section className="space-y-4">
        <form method="GET" action="/remote-jobs" className="flex gap-2 max-w-2xl">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted)]"
            />
            <input
              type="text"
              name="q"
              defaultValue={searchQuery}
              placeholder="Search by role, company, skill (e.g. React, Product Manager, Go)..."
              className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] pl-10 pr-4 py-2.5 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--red)] transition-colors shadow-sm"
            />
          </div>
          <button
            type="submit"
            className="soft-button primary text-xs !py-2.5 !px-4 shrink-0"
          >
            <span>Search</span>
          </button>
          {searchQuery && (
            <Link
              href="/remote-jobs"
              className="soft-button secondary text-xs !py-2.5 !px-3 flex items-center gap-1 shrink-0"
              title="Clear search"
            >
              <X size={14} />
              <span>Clear</span>
            </Link>
          )}
        </form>

        {/* Category Pills Filter */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-[var(--muted)]">
            <Filter size={14} />
            <span>Browse by Category & Region:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {SEO_CATEGORIES.map((cat) => (
              <Link
                key={cat.slug}
                href={`/remote-jobs/${cat.slug}`}
                className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] hover:bg-[var(--red-soft)] transition-all"
              >
                {cat.title}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Jobs Grid */}
      <section className="space-y-6">
        <div className="flex items-center justify-between border-b border-[var(--line)] pb-4">
          <div>
            <h2 className="text-xl font-semibold text-[var(--ink)]">
              {searchQuery ? `Search Results for "${searchQuery}"` : 'Active Remote Positions'}
            </h2>
            <p className="text-xs sm:text-sm text-[var(--muted)] mt-0.5">
              {totalJobs > jobs.length
                ? `Showing ${pageOffset + 1}–${pageOffset + jobs.length} of ${totalJobs} verified positions`
                : `Showing ${totalJobs} verified position${totalJobs === 1 ? '' : 's'}`}
            </p>
          </div>
          <Link
            href="/feed"
            className="text-xs sm:text-sm font-medium text-[var(--red)] hover:underline flex items-center gap-1"
          >
            <span>Interactive Match Deck</span>
            <ArrowRight size={13} />
          </Link>
        </div>

        {jobs.length === 0 ? (
          <div className="soft-card p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-[var(--ink)]">
              No remote jobs found matching &ldquo;{searchQuery}&rdquo;.
            </p>
            <p className="text-sm text-[var(--muted)]">
              Try searching by a broader skill like &ldquo;TypeScript&rdquo;, &ldquo;Product&rdquo;, or &ldquo;Design&rdquo;.
            </p>
            <div className="pt-2">
              <Link href="/remote-jobs" className="soft-button secondary text-sm">
                View all active jobs
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {jobs.map((job) => (
              <article
                key={job.sourceId}
                className="soft-card p-6 flex flex-col justify-between hover:shadow-md transition-shadow group border border-[var(--line)] bg-[var(--surface)]"
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium text-[var(--muted)]">{job.company}</span>
                      <h3 className="text-base sm:text-lg font-semibold text-[var(--ink)] group-hover:text-[var(--red)] transition-colors mt-0.5">
                        <Link href={`/remote-jobs/view/${job.sourceId}`}>
                          {job.title}
                        </Link>
                      </h3>
                    </div>
                    <span className="tag whitespace-nowrap">
                      {job.employmentType}
                    </span>
                  </div>

                  <p className="text-sm text-[var(--muted)] line-clamp-2 leading-relaxed">
                    {job.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs sm:text-sm text-[var(--muted)]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={13} className="text-[var(--muted)]" />
                      {job.remoteType}
                    </span>
                    {formatSalaryRange(job) && (
                      <span className="inline-flex items-center gap-1 tabular-nums font-medium text-[var(--ink)]">
                        <DollarSign size={13} className="text-[var(--red)]" />
                        {formatSalaryRange(job)}
                      </span>
                    )}
                  </div>

                  {job.requiredSkills && job.requiredSkills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {job.requiredSkills.slice(0, 4).map((tag, idx) => (
                        <span
                          key={idx}
                          className="rounded-md bg-[var(--surface-soft)] px-2.5 py-1 text-xs text-[var(--muted)] border border-[var(--line)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-5 pt-4 border-t border-[var(--line)] flex items-center justify-between gap-3">
                  <Link
                    href={`/remote-jobs/view/${job.sourceId}`}
                    className="text-sm font-semibold text-[var(--red)] hover:underline flex items-center gap-1"
                  >
                    <span>View job details</span>
                    <ArrowRight size={13} />
                  </Link>
                  <Link
                    href="/onboarding"
                    className="soft-button secondary text-sm !py-1.5 !px-3"
                  >
                    <span>Check my match score →</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
        <Pagination basePath="/remote-jobs" page={currentPage} totalPages={totalPages} query={searchQuery ? { q: searchQuery } : undefined} />
      </section>

      {/* Directory FAQ (3-Part Answer Structure) */}
      <section className="soft-card p-6 sm:p-8 space-y-6">
        <div>
          <span className="tag">Questions & Answers</span>
          <h2 className="text-xl font-semibold text-[var(--ink)] mt-2">
            Frequently Asked Questions About Remote Jobs on RemoteMatch
          </h2>
        </div>

        <div className="divide-y divide-[var(--line)]">
          {directoryFaqs.map((faq, idx) => (
            <div key={idx} className="py-4 space-y-2 first:pt-0 last:pb-0">
              <h3 className="text-base font-semibold text-[var(--ink)]">{faq.q}</h3>
              <p className="text-sm sm:text-base font-medium text-[var(--ink)] leading-relaxed">
                {faq.directAnswer}
              </p>
              <p className="text-sm sm:text-base text-[var(--muted)] leading-relaxed">
                {faq.explanation}
              </p>
              <div>
                <Link
                  href={faq.linkHref}
                  className="text-sm font-semibold text-[var(--red)] hover:underline inline-flex items-center gap-1"
                >
                  <span>{faq.linkText}</span>
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Conversion Footer Banner */}
      <div className="soft-card p-8 text-center space-y-4 bg-gradient-to-b from-white to-[var(--surface-soft)]">
        <span className="tag">Know Your Chances Before You Apply</span>
        <h2 className="text-2xl font-semibold text-[var(--ink)]">
          Find remote jobs worth applying to.
        </h2>
        <p className="text-sm text-[var(--muted)] max-w-md mx-auto leading-relaxed">
          See remote jobs that fit your experience, understand why they match, and apply with more confidence.
        </p>
        <div className="pt-2">
          <Link href="/onboarding" className="soft-button primary text-sm">
            <span>Find your matches →</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
