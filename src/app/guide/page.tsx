import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Clock, Calendar, BookOpen, Filter } from 'lucide-react';
import { SEO_GUIDE_ARTICLES, SEO_CATEGORIES, buildBreadcrumbSchema } from '@/lib/seo/data';

export const metadata: Metadata = {
  title: 'Remote Job Search Guides — Tactical Advice for Remote Professionals | RemoteMatch',
  description:
    'Tactical guides on remote job matching, evaluating requirements, crafting tailored proposals, navigating timezones, and negotiating remote salaries.',
  alternates: {
    canonical: 'https://remotematch.com/guide',
  },
  openGraph: {
    title: 'Remote Job Search Guides | RemoteMatch',
    description:
      'Learn how to find remote jobs worth applying to, understand fit, and apply with confidence.',
    url: 'https://remotematch.com/guide',
    type: 'website',
  },
};

export default function GuideHubPage() {
  const breadcrumbsSchema = buildBreadcrumbSchema([
    { name: 'Home', url: 'https://remotematch.com' },
    { name: 'Guides', url: 'https://remotematch.com/guide' },
  ]);

  const jsonLdCollection = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Remote Job Search Guides',
    description: 'Expert editorial guides for landing high-fit remote positions.',
    url: 'https://remotematch.com/guide',
    hasPart: SEO_GUIDE_ARTICLES.map((article) => ({
      '@type': 'Article',
      headline: article.title,
      description: article.description,
      datePublished: article.publishedDate,
      author: {
        '@type': 'Organization',
        name: article.author,
      },
      url: `https://remotematch.com/guide/${article.slug}`,
    })),
  };

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto space-y-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdCollection) }}
      />

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">
          Home
        </Link>
        <span>/</span>
        <span className="text-[var(--ink)] font-medium">Remote Guides</span>
      </nav>

      {/* Hub Header with AEO Top-of-Page Answer */}
      <header className="space-y-4 max-w-3xl">
        <span className="tag">Tactical Guides</span>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[var(--ink)]">
          Practical guides for the modern remote job search.
        </h1>
        <div className="soft-card p-5 bg-[var(--surface-soft)] border border-[var(--line)]">
          <p className="text-sm font-medium text-[var(--ink)] leading-relaxed">
            RemoteMatch provides tactical guides to help remote job seekers evaluate job requirements, navigate international timezones, understand transparent salary structures, write concise proposal letters, and track applications from application to offer.
          </p>
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Read practical recommendations below, or explore verified remote openings in our active directory.
          </p>
        </div>
      </header>

      {/* Topical Clusters Navigation */}
      <div className="flex flex-wrap gap-2 pt-1">
        <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mr-2 self-center">
          Topical Clusters:
        </span>
        {Array.from(new Set(SEO_GUIDE_ARTICLES.map((a) => a.topicalCluster))).map((cluster) => (
          <span
            key={cluster}
            className="rounded-full bg-[var(--surface)] border border-[var(--line)] px-3 py-1 text-[11px] font-medium text-[var(--ink)] shadow-sm"
          >
            {cluster}
          </span>
        ))}
      </div>

      {/* Articles Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {SEO_GUIDE_ARTICLES.map((article) => (
          <article
            key={article.slug}
            className="soft-card p-6 sm:p-7 flex flex-col justify-between hover:shadow-md transition-shadow group border border-[var(--line)] bg-[var(--surface)]"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                <span className="tag !text-[10px] !bg-[var(--surface-soft)]">
                  {article.category}
                </span>
                <span className="flex items-center gap-1">
                  <Clock size={12} />
                  {article.readingTime}
                </span>
              </div>

              <h2 className="text-lg font-semibold text-[var(--ink)] group-hover:text-[var(--red)] transition-colors leading-snug">
                <Link href={`/guide/${article.slug}`}>
                  {article.title}
                </Link>
              </h2>

              <p className="text-xs text-[var(--muted)] leading-relaxed line-clamp-3">
                {article.description}
              </p>
            </div>

            <div className="mt-6 pt-4 border-t border-[var(--line)] flex items-center justify-between">
              <span className="text-[11px] text-[var(--muted)] flex items-center gap-1">
                <Calendar size={12} />
                {article.publishedDate}
              </span>
              <Link
                href={`/guide/${article.slug}`}
                className="text-xs font-semibold text-[var(--red)] hover:underline flex items-center gap-1"
              >
                <span>Read guide</span>
                <ArrowRight size={13} />
              </Link>
            </div>
          </article>
        ))}
      </div>

      {/* Relevant Hubs Integration */}
      <section className="soft-card p-6 sm:p-8 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          Explore Related Remote Opportunities by Category
        </h3>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Put these strategies into practice with verified live opportunities in our curated directory:
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {SEO_CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              href={`/remote-jobs/${cat.slug}`}
              className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              {cat.title}
            </Link>
          ))}
        </div>
      </section>

      {/* Conversion Banner */}
      <div className="soft-card p-8 text-center space-y-4 bg-gradient-to-b from-white to-[var(--surface-soft)]">
        <span className="tag">Know Your Chances Before You Apply</span>
        <h2 className="text-2xl font-semibold text-[var(--ink)]">
          Put tactical advice to work on your real profile.
        </h2>
        <p className="text-xs text-[var(--muted)] max-w-md mx-auto leading-relaxed">
          Upload your resume, set your role preferences, and see which remote opportunities match your experience best.
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
