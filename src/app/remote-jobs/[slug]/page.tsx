import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, MapPin, DollarSign, Briefcase, Filter } from 'lucide-react';
import {
  SEO_CATEGORIES,
  getJobsForCategory,
  buildBreadcrumbSchema,
  buildJobPostingSchema,
  formatSalaryRange,
} from '@/lib/seo/data';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return SEO_CATEGORIES.map((cat) => ({
    slug: cat.slug,
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = SEO_CATEGORIES.find((c) => c.slug === slug);
  if (!category) return {};

  return {
    title: category.metaTitle,
    description: category.metaDescription,
    alternates: {
      canonical: `https://remotematch.com/remote-jobs/${category.slug}`,
    },
    openGraph: {
      title: category.metaTitle,
      description: category.metaDescription,
      url: `https://remotematch.com/remote-jobs/${category.slug}`,
      type: 'website',
    },
  };
}

export default async function RemoteCategoryPage({ params }: Props) {
  const { slug } = await params;
  const category = SEO_CATEGORIES.find((c) => c.slug === slug);
  if (!category) notFound();

  const supabase = createSupabaseServerClient();
  const jobs = supabase ? await getJobsForCategory(category.slug, supabase) : [];
  const otherCategories = SEO_CATEGORIES.filter((c) => c.slug !== category.slug);

  const breadcrumbsSchema = buildBreadcrumbSchema([
    { name: 'Home', url: 'https://remotematch.com' },
    { name: 'Remote Jobs', url: 'https://remotematch.com/remote-jobs' },
    { name: category.title, url: `https://remotematch.com/remote-jobs/${category.slug}` },
  ]);

  const jsonLdCategory = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: category.h1,
    description: category.metaDescription,
    numberOfItems: jobs.length,
    itemListElement: jobs
      .map((job, index) => {
        const posting = buildJobPostingSchema(job);
        if (!posting) return null;
        return {
          '@type': 'ListItem',
          position: index + 1,
          item: posting,
        };
      })
      .filter(Boolean),
  };

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto space-y-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdCategory) }}
      />

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">
          Home
        </Link>
        <span>/</span>
        <Link href="/remote-jobs" className="hover:text-[var(--ink)] transition-colors">
          Remote Jobs
        </Link>
        <span>/</span>
        <span className="text-[var(--ink)] font-medium">{category.title}</span>
      </nav>

      {/* Category Header with AEO Top-of-Page Direct Answer */}
      <header className="space-y-4 max-w-3xl">
        <span className="tag">
          {category.type === 'role' ? 'Role Hub' : category.type === 'location' ? 'Regional Hub' : 'Experience Level'}
        </span>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--ink)]">
          {category.h1}
        </h1>
        <div className="soft-card p-5 bg-[var(--surface-soft)] border border-[var(--line)]">
          <p className="text-sm font-medium text-[var(--ink)] leading-relaxed">
            {category.directAnswer}
          </p>
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            {category.intro}
          </p>
        </div>
        <div className="pt-1 flex flex-wrap items-center gap-3">
          <Link href="/onboarding" className="soft-button primary text-sm">
            <span>Find your matches in {category.title} →</span>
          </Link>
          <Link href="/remote-jobs" className="soft-button secondary text-sm">
            <span>← All remote jobs</span>
          </Link>
        </div>
      </header>

      {/* Relevant Skills Tags */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mr-2">
          Relevant skills:
        </span>
        {category.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-[var(--surface-soft)] border border-[var(--line)] px-3 py-1 text-xs text-[var(--ink)]"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* Jobs Feed for this Category */}
      <section className="space-y-6">
        <div className="flex items-center justify-between border-b border-[var(--line)] pb-4">
          <div>
            <h2 className="text-xl font-semibold text-[var(--ink)]">
              {category.title} Listings
            </h2>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Showing {jobs.length} verified active position{jobs.length === 1 ? '' : 's'}
            </p>
          </div>
          <Link
            href="/feed"
            className="text-xs font-medium text-[var(--red)] hover:underline flex items-center gap-1"
          >
            <span>Interactive Match Deck</span>
            <ArrowRight size={13} />
          </Link>
        </div>

        {jobs.length === 0 ? (
          <div className="soft-card p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-[var(--ink)]">
              No active listings in this category right now.
            </p>
            <p className="text-xs text-[var(--muted)]">
              We update verified listings continuously. Browse all remote openings or create a match profile.
            </p>
            <div className="pt-2">
              <Link href="/remote-jobs" className="soft-button secondary text-xs">
                Browse all remote jobs
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
                      <span className="text-xs font-medium text-[var(--muted)]">{job.company}</span>
                      <h3 className="text-base font-semibold text-[var(--ink)] group-hover:text-[var(--red)] transition-colors mt-0.5">
                        <Link href={`/remote-jobs/view/${job.sourceId}`}>
                          {job.title}
                        </Link>
                      </h3>
                    </div>
                    <span className="tag !text-[11px] whitespace-nowrap">
                      {job.employmentType}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--muted)] line-clamp-3 leading-relaxed">
                    {job.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs text-[var(--muted)]">
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={13} className="text-[var(--muted)]" />
                      {job.remoteType}
                    </span>
                    {formatSalaryRange(job) && (
                      <span className="inline-flex items-center gap-1 font-mono font-medium text-[var(--ink)]">
                        <DollarSign size={13} className="text-[var(--red)]" />
                        {formatSalaryRange(job)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-[var(--line)] flex items-center justify-between gap-3">
                  <Link
                    href={`/remote-jobs/view/${job.sourceId}`}
                    className="text-xs font-semibold text-[var(--red)] hover:underline flex items-center gap-1"
                  >
                    <span>View job details</span>
                    <ArrowRight size={13} />
                  </Link>
                  <Link
                    href="/onboarding"
                    className="soft-button secondary text-xs !py-1 !px-2.5"
                  >
                    <span>Check my match score →</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Category FAQ Section (3-Part Answer Structure) */}
      {category.faqs.length > 0 && (
        <section className="soft-card p-6 sm:p-8 space-y-6">
          <div>
            <span className="tag">Direct Answers</span>
            <h2 className="text-xl font-semibold text-[var(--ink)] mt-2">
              Frequently Asked Questions: {category.title}
            </h2>
          </div>

          <div className="divide-y divide-[var(--line)]">
            {category.faqs.map((faq, idx) => (
              <div key={idx} className="py-4 space-y-2 first:pt-0 last:pb-0">
                <h3 className="text-sm font-semibold text-[var(--ink)]">{faq.q}</h3>
                <p className="text-xs font-medium text-[var(--ink)] leading-relaxed">
                  {faq.directAnswer}
                </p>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  {faq.explanation}
                </p>
                <div>
                  <Link
                    href={faq.linkHref}
                    className="text-xs font-semibold text-[var(--red)] hover:underline inline-flex items-center gap-1"
                  >
                    <span>{faq.linkText}</span>
                    <ArrowRight size={12} />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Internal Linking: Other Hubs */}
      <section className="space-y-3 pt-2">
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
          Explore Other Remote Categories & Locations
        </h3>
        <div className="flex flex-wrap gap-2">
          {otherCategories.map((c) => (
            <Link
              key={c.slug}
              href={`/remote-jobs/${c.slug}`}
              className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:border-[var(--muted)] transition-colors"
            >
              {c.title}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
