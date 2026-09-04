import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  ExternalLink,
  MapPin,
  DollarSign,
  Briefcase,
  Calendar,
  Target,
  AlertCircle,
  Clock,
} from 'lucide-react';
import { CURATED_JOBS } from '@/lib/providers/curated';
import {
  getJobById,
  getActiveJobs,
  isJobIndexable,
  buildBreadcrumbSchema,
  buildJobPostingSchema,
  SEO_CATEGORIES,
} from '@/lib/seo/data';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
  return CURATED_JOBS.map((job) => ({
    id: job.sourceId,
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) return {};

  const isLive = isJobIndexable(job);
  const salaryText = job.salaryString ? ` Salary: ${job.salaryString}.` : '';
  const locText = job.locationString ? ` Location: ${job.locationString}.` : '';

  return {
    title: `${job.title} at ${job.company} (Remote) | RemoteMatch`,
    description: `${job.title} remote opportunity at ${job.company}.${salaryText}${locText} Know your chances before you apply with RemoteMatch.`,
    alternates: {
      canonical: `https://remotematch.com/remote-jobs/view/${job.sourceId}`,
    },
    robots: isLive
      ? { index: true, follow: true }
      : { index: false, follow: true },
    openGraph: {
      title: `${job.title} at ${job.company} — Remote Role`,
      description: job.description.slice(0, 160),
      url: `https://remotematch.com/remote-jobs/view/${job.sourceId}`,
      type: 'website',
    },
  };
}

export default async function PublicJobDetailPage({ params }: Props) {
  const { id } = await params;
  const job = getJobById(id);
  if (!job) notFound();

  const isLive = isJobIndexable(job);
  const activeJobs = getActiveJobs();
  const relatedJobs = activeJobs.filter((j) => j.sourceId !== job.sourceId).slice(0, 3);

  // Match relevant category for breadcrumb trail
  const matchedCategory = SEO_CATEGORIES.find((cat) => {
    const titleLower = job.title.toLowerCase();
    const tagsLower = (job.tags || []).map((t) => t.toLowerCase());
    return (
      cat.tags.some((t) => tagsLower.includes(t.toLowerCase())) ||
      titleLower.includes(cat.slug.replace('-', ' '))
    );
  });

  const breadcrumbItems = [
    { name: 'Home', url: 'https://remotematch.com' },
    { name: 'Remote Jobs', url: 'https://remotematch.com/remote-jobs' },
  ];
  if (matchedCategory) {
    breadcrumbItems.push({
      name: matchedCategory.title,
      url: `https://remotematch.com/remote-jobs/${matchedCategory.slug}`,
    });
  }
  breadcrumbItems.push({
    name: job.title,
    url: `https://remotematch.com/remote-jobs/view/${job.sourceId}`,
  });

  const breadcrumbsSchema = buildBreadcrumbSchema(breadcrumbItems);
  const jobPostingSchema = isLive ? buildJobPostingSchema(job) : null;

  return (
    <div className="min-h-screen py-10 px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsSchema) }}
      />
      {jobPostingSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jobPostingSchema) }}
        />
      )}

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--muted)] flex items-center gap-2">
        <Link href="/" className="hover:text-[var(--ink)] transition-colors">
          Home
        </Link>
        <span>/</span>
        <Link href="/remote-jobs" className="hover:text-[var(--ink)] transition-colors">
          Remote Jobs
        </Link>
        {matchedCategory && (
          <>
            <span>/</span>
            <Link
              href={`/remote-jobs/${matchedCategory.slug}`}
              className="hover:text-[var(--ink)] transition-colors"
            >
              {matchedCategory.title}
            </Link>
          </>
        )}
        <span>/</span>
        <span className="text-[var(--ink)] font-medium truncate max-w-[200px] sm:max-w-none">
          {job.title}
        </span>
      </nav>

      {/* Closed Position Notice (For Expired Jobs Retained for Historical Reference) */}
      {!isLive && (
        <div className="rounded-2xl border border-[var(--line)] bg-[#fff5f5] p-5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-red-700">
            <AlertCircle size={16} />
            <span>This position at {job.company} has closed</span>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            This job posting is no longer accepting new applications. You can explore active remote positions matching this role below or calculate your match score for active openings.
          </p>
          <div className="pt-2">
            <Link href="/remote-jobs" className="soft-button secondary text-xs">
              Browse active remote jobs →
            </Link>
          </div>
        </div>
      )}

      {/* Main Job Details Card */}
      <article className="soft-card p-6 sm:p-8 space-y-6 bg-white border border-[var(--line)]">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                {job.company}
              </span>
              <span className="tag !text-[10px]">
                {isLive ? '100% Remote' : 'Closed'}
              </span>
              {job.status === 'UPDATED' && (
                <span className="tag !text-[10px] !bg-[#ecfdf5] !text-[#059669] !border-[#a7f3d0]">
                  Updated
                </span>
              )}
            </div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
              {job.title}
            </h1>
          </div>

          {isLive && (
            <div className="flex flex-wrap items-center gap-2 self-start">
              <a
                href={job.officialUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="soft-button primary text-xs flex items-center gap-1.5"
              >
                <span>Apply on employer&apos;s website</span>
                <ExternalLink size={13} />
              </a>
            </div>
          )}
        </div>

        {/* Factual Metadata Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 pb-3 border-y border-[var(--line)]">
          {job.jobType && (
            <div className="space-y-0.5">
              <span className="text-[11px] text-[var(--muted)] flex items-center gap-1">
                <Briefcase size={12} /> Employment
              </span>
              <p className="text-xs font-semibold text-[var(--ink)]">{job.jobType}</p>
            </div>
          )}
          {job.locationString && (
            <div className="space-y-0.5">
              <span className="text-[11px] text-[var(--muted)] flex items-center gap-1">
                <MapPin size={12} /> Remote Scope
              </span>
              <p className="text-xs font-semibold text-[var(--ink)]">{job.locationString}</p>
            </div>
          )}
          {job.salaryString && (
            <div className="space-y-0.5">
              <span className="text-[11px] text-[var(--muted)] flex items-center gap-1">
                <DollarSign size={12} /> Compensation
              </span>
              <p className="text-xs font-semibold text-[var(--ink)] font-mono">{job.salaryString}</p>
            </div>
          )}
          <div className="space-y-0.5">
            <span className="text-[11px] text-[var(--muted)] flex items-center gap-1">
              <Calendar size={12} /> Date Posted
            </span>
            <p className="text-xs font-semibold text-[var(--ink)]">
              {new Date(job.publicationDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>
        </div>

        {/* Conversion Callout: Know your chances before you apply */}
        <div className="rounded-2xl border border-[#fcd5dc] bg-[#fdf2f4] p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--red)]">
              <Target size={14} />
              <span>Know your chances before you apply</span>
            </div>
            <p className="text-xs text-[var(--ink)] max-w-lg leading-relaxed">
              RemoteMatch analyzes your experience against this role&apos;s specific tech stack, timezone overlap, and requirements.
            </p>
          </div>
          <Link
            href="/onboarding"
            className="soft-button primary text-xs whitespace-nowrap self-stretch sm:self-auto text-center"
          >
            <span>Check my match score →</span>
          </Link>
        </div>

        {/* Factual Job Description */}
        <section className="space-y-3 pt-2">
          <h2 className="text-base font-semibold text-[var(--ink)]">About the Role</h2>
          <div className="text-xs sm:text-sm text-[var(--muted)] leading-relaxed space-y-3">
            <p>{job.description}</p>
          </div>
        </section>

        {/* Factual Skills & Tech Stack */}
        {job.tags && job.tags.length > 0 && (
          <section className="space-y-3 pt-2">
            <h2 className="text-base font-semibold text-[var(--ink)]">Required Skills & Technologies</h2>
            <div className="flex flex-wrap gap-2">
              {job.tags.map((tag, idx) => (
                <span
                  key={idx}
                  className="rounded-lg bg-[var(--surface-soft)] border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink)] font-medium"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Freshness & Sourcing Note */}
        <div className="text-[11px] text-[var(--muted)] pt-3 border-t border-[var(--line)] flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            <Clock size={11} />
            Verified active: {job.updatedAt ? new Date(job.updatedAt).toLocaleDateString() : new Date(job.publicationDate).toLocaleDateString()}
          </span>
          {matchedCategory && (
            <Link
              href={`/remote-jobs/${matchedCategory.slug}`}
              className="text-[var(--red)] hover:underline"
            >
              Explore more {matchedCategory.title} jobs →
            </Link>
          )}
        </div>

        {/* Action Footer */}
        <div className="pt-4 border-t border-[var(--line)] flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link
            href="/remote-jobs"
            className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            ← Back to all remote jobs
          </Link>
          {isLive && (
            <a
              href={job.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="soft-button primary text-xs flex items-center gap-1.5 w-full sm:w-auto justify-center"
            >
              <span>Apply on {job.company}&apos;s website</span>
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </article>

      {/* Related Active Opportunities */}
      {relatedJobs.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-[var(--ink)]">
            Other Active Remote Opportunities
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {relatedJobs.map((related) => (
              <Link
                key={related.sourceId}
                href={`/remote-jobs/view/${related.sourceId}`}
                className="soft-card p-4 hover:shadow-sm transition-all group block border border-[var(--line)] bg-white"
              >
                <span className="text-[11px] text-[var(--muted)] block">{related.company}</span>
                <h3 className="text-xs font-semibold text-[var(--ink)] group-hover:text-[var(--red)] transition-colors mt-0.5 line-clamp-1">
                  {related.title}
                </h3>
                <p className="text-[11px] text-[var(--muted)] mt-2 font-mono">
                  {related.salaryString || related.locationString || 'Worldwide'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
