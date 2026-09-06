import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Clock, Calendar, ArrowRight, CheckCircle2 } from 'lucide-react';
import { SEO_GUIDE_ARTICLES, SEO_CATEGORIES, buildBreadcrumbSchema } from '@/lib/seo/data';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return SEO_GUIDE_ARTICLES.map((article) => ({
    slug: article.slug,
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = SEO_GUIDE_ARTICLES.find((a) => a.slug === slug);
  if (!article) return {};

  return {
    title: `${article.title} — Remote Job Guide | RemoteMatch`,
    description: article.description,
    alternates: {
      canonical: `https://remotematch.com/guide/${article.slug}`,
    },
    openGraph: {
      title: article.title,
      description: article.description,
      type: 'article',
      publishedTime: article.publishedDate,
      authors: [article.author],
      url: `https://remotematch.com/guide/${article.slug}`,
    },
  };
}

export default async function GuideArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = SEO_GUIDE_ARTICLES.find((a) => a.slug === slug);
  if (!article) notFound();

  const nextArticle =
    SEO_GUIDE_ARTICLES.find((a) => a.slug !== article.slug) || SEO_GUIDE_ARTICLES[0];

  const breadcrumbsSchema = buildBreadcrumbSchema([
    { name: 'Home', url: 'https://remotematch.com' },
    { name: 'Guides', url: 'https://remotematch.com/guide' },
    { name: article.title, url: `https://remotematch.com/guide/${article.slug}` },
  ]);

  const jsonLdArticle = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    datePublished: article.publishedDate,
    author: {
      '@type': 'Organization',
      name: article.author,
    },
    publisher: {
      '@type': 'Organization',
      name: 'RemoteMatch',
      logo: {
        '@type': 'ImageObject',
        url: 'https://remotematch.com/logo.png',
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://remotematch.com/guide/${article.slug}`,
    },
  };

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-3xl mx-auto space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdArticle) }}
      />

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">
          Home
        </Link>
        <span>/</span>
        <Link href="/guide" className="hover:text-[var(--ink)] transition-colors">
          Guides
        </Link>
        <span>/</span>
        <span className="text-[var(--ink)] font-medium truncate max-w-[200px] sm:max-w-none">
          {article.title}
        </span>
      </nav>

      {/* Article Header */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tag">{article.category}</span>
          <span className="tag !bg-[var(--surface)] !text-[var(--muted)] !border-[var(--line)]">
            {article.topicalCluster}
          </span>
          <span className="text-xs text-[var(--muted)] flex items-center gap-1">
            <Clock size={12} />
            {article.readingTime}
          </span>
        </div>
        <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight text-[var(--ink)] leading-tight">
          {article.title}
        </h1>
        <div className="flex items-center gap-4 text-xs text-[var(--muted)] pt-1 border-b border-[var(--line)] pb-4">
          <span>By {article.author}</span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <Calendar size={12} />
            {article.publishedDate}
          </span>
        </div>
      </header>

      {/* AEO Top-of-Page Direct Answer Box */}
      <div className="soft-card p-5 bg-[var(--surface-soft)] border border-[var(--line)]">
        <p className="text-xs font-semibold text-[var(--red)] uppercase tracking-wider mb-1">
          Direct Summary
        </p>
        <p className="text-sm font-medium text-[var(--ink)] leading-relaxed">
          {article.directAnswer}
        </p>
      </div>

      {/* Article Body */}
      <article className="space-y-6 text-sm text-[var(--ink)] leading-relaxed">
        {article.content.map((paragraph, idx) => (
          <p key={idx} className="text-sm sm:text-base leading-relaxed text-[var(--muted)]">
            {paragraph}
          </p>
        ))}

        {/* Key Takeaways Box */}
        <div className="soft-card p-6 sm:p-7 space-y-3 bg-[var(--surface)] border border-[var(--line)] my-6">
          <div className="flex items-center gap-2 font-semibold text-sm text-[var(--ink)]">
            <CheckCircle2 size={16} className="text-[var(--red)]" />
            <span>Key Takeaways</span>
          </div>
          <ul className="space-y-2 text-xs text-[var(--ink)] pl-2">
            {article.takeaways.map((takeaway, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-[var(--red)] font-bold">•</span>
                <span>{takeaway}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Relevant Roles & Hubs Internal Linking */}
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-5 space-y-3">
          <p className="text-xs font-semibold text-[var(--ink)] uppercase tracking-wider">
            Explore Opportunities Related to this Guide:
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              href="/remote-jobs/software-engineering"
              className="rounded-lg bg-[var(--surface)] border border-[var(--line)] px-3 py-1.5 font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              Remote Software Engineering
            </Link>
            <Link
              href="/remote-jobs/product-management"
              className="rounded-lg bg-[var(--surface)] border border-[var(--line)] px-3 py-1.5 font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              Remote Product Management
            </Link>
            <Link
              href="/remote-jobs/worldwide"
              className="rounded-lg bg-[var(--surface)] border border-[var(--line)] px-3 py-1.5 font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              Worldwide Remote Jobs
            </Link>
            <Link
              href="/remote-jobs"
              className="rounded-lg bg-[var(--surface)] border border-[var(--line)] px-3 py-1.5 font-medium text-[var(--ink)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              Full Job Directory
            </Link>
          </div>
        </div>

        {/* RemoteMatch Conversion Callout */}
        <div className="rounded-2xl border border-[var(--red-soft-border)] bg-[var(--red-soft)] p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 my-8">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-[var(--red)] flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              <span>Know your chances before you apply</span>
            </span>
            <p className="text-xs text-[var(--ink)]">
              Let RemoteMatch compare your profile with verified remote jobs and highlight what matches.
            </p>
          </div>
          <Link
            href="/onboarding"
            className="soft-button primary text-xs whitespace-nowrap self-stretch sm:self-auto text-center"
          >
            <span>Find your matches →</span>
          </Link>
        </div>

        {/* 3-Part Answer FAQ Section */}
        {article.faqs.length > 0 && (
          <div className="soft-card p-6 space-y-4 mt-8 border border-[var(--line)] bg-[var(--surface)]">
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              Questions Answered in This Guide
            </h3>
            <div className="divide-y divide-[var(--line)]">
              {article.faqs.map((faq, idx) => (
                <div key={idx} className="py-3 space-y-2 first:pt-0 last:pb-0">
                  <h4 className="text-xs font-semibold text-[var(--ink)]">{faq.q}</h4>
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
          </div>
        )}
      </article>

      {/* Navigation Footer */}
      <footer className="pt-8 border-t border-[var(--line)] flex flex-col sm:flex-row items-center justify-between gap-4">
        <Link
          href="/guide"
          className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        >
          ← Back to all guides
        </Link>
        {nextArticle && (
          <Link
            href={`/guide/${nextArticle.slug}`}
            className="text-xs font-semibold text-[var(--red)] hover:underline flex items-center gap-1"
          >
            <span>Next: {nextArticle.title}</span>
            <ArrowRight size={13} />
          </Link>
        )}
      </footer>
    </div>
  );
}
