'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  CircleCheck,
  MapPin,
} from 'lucide-react';

const PREVIEW_JOBS = [
  {
    id: 'opp_curated_1',
    company: 'Acme',
    badge: 'A',
    badgeBg: 'bg-[#5e6ad2] text-white',
    title: 'Senior Product Manager',
    location: 'Remote',
    salary: '$150k–$180k',
    score: 84,
    fitLabel: 'Strong match',
    whyMatches: 'Your product leadership and SaaS experience line up well with this role.',
    missingItem: 'The role asks for experience with enterprise procurement.',
  },
  {
    id: 'opp_curated_2',
    company: 'Stripe',
    badge: 'S',
    badgeBg: 'bg-[#635bff] text-white',
    title: 'Senior Software Engineer',
    location: 'Remote · Worldwide',
    salary: '$150k–$190k',
    score: 96,
    fitLabel: 'Strong match',
    whyMatches: 'Your full stack architecture and distributed systems experience match this role directly.',
    missingItem: 'Production-scale payments experience is not clear from your profile.',
  },
  {
    id: 'opp_curated_3',
    company: 'Mercury',
    badge: 'M',
    badgeBg: 'bg-[#111827] text-white',
    title: 'Staff Backend Engineer',
    location: 'Remote · Americas / Europe',
    salary: '$160k–$210k',
    score: 88,
    fitLabel: 'Good match',
    whyMatches: 'Your deep PostgreSQL and high availability systems background align with the team roadmap.',
    missingItem: 'Haskell and Nix production usage are not highlighted in your profile.',
  },
];

export default function LandingPage() {
  const [activeIdx, setActiveIdx] = useState(0);
  const current = PREVIEW_JOBS[activeIdx];

  return (
    <main className="page">
      {/* 1. Hero Section */}
      <section className="container grid items-center gap-12 py-14 lg:grid-cols-[1.1fr_480px] lg:py-20">
        <div>
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-[#fdf2f4] text-[var(--red)] border border-[#fcd5dc]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--red)] animate-pulse" />
            Less searching. Better matches.
          </span>
          <h1 className="mt-6 max-w-2xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl lg:text-6xl text-[var(--ink)] leading-[1.1]">
            Find remote jobs <span className="text-[var(--red)]">worth applying to.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-[var(--muted)]">
            See remote jobs that fit your experience, understand why they match, and apply with more confidence.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/onboarding"
              className="soft-button primary inline-flex items-center justify-center gap-2 text-sm"
            >
              <span>Find your matches →</span>
              <ArrowRight size={17} />
            </Link>
            <Link
              href="/feed"
              className="soft-button secondary inline-flex items-center justify-center text-sm"
            >
              <span>Browse remote jobs</span>
            </Link>
          </div>

          <div className="mt-8 flex flex-wrap gap-5 text-xs text-[var(--muted)]">
            <span className="flex items-center gap-1.5 font-medium">
              <CircleCheck size={16} className="text-[#059669]" />
              <span>Know your chances before you apply</span>
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <CircleCheck size={16} className="text-[#059669]" />
              <span>Eligibility verified</span>
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <CircleCheck size={16} className="text-[#059669]" />
              <span>Track every application</span>
            </span>
          </div>
        </div>

        {/* 2. Product Preview Card */}
        <div className="soft-card p-6 border border-[#F3E8E2] rounded-3xl shadow-sm">
          {/* Card Header & Preview Switcher */}
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-[#F3E8E2]">
            <div>
              <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
                Jobs picked for you
              </h3>
              <p className="text-[11px] text-[var(--muted)] mt-0.5">
                A focused list of remote opportunities matched to your experience.
              </p>
            </div>
            <div className="flex items-center gap-1">
              {PREVIEW_JOBS.map((job, idx) => (
                <button
                  key={job.company}
                  onClick={() => setActiveIdx(idx)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-xl transition-colors min-h-[36px] ${
                    activeIdx === idx
                      ? 'bg-[var(--red)] text-white font-semibold shadow-sm'
                      : 'bg-[#FFF1EA] text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  {job.company}
                </button>
              ))}
            </div>
          </div>

          {/* Job Overview & Score Dial */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className={`grid size-11 place-items-center rounded-2xl font-bold text-sm shadow-sm ${current.badgeBg}`}>
                {current.badge}
              </div>
              <p className="mt-3 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                {current.company}
              </p>
              <h2 className="text-xl font-bold text-[var(--ink)] mt-0.5">
                {current.title}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <span className="flex items-center gap-1">
                  <MapPin size={13} className="text-[var(--red)]" />
                  {current.location}
                </span>
                <span>·</span>
                <span className="font-mono">{current.salary}</span>
              </div>
            </div>

            {/* Coral-Red Score Box */}
            <div className="rounded-2xl bg-[#fdf2f4] border border-[#fcd5dc] px-4 py-3 text-center min-w-[95px] shrink-0">
              <div className="mono text-3xl font-bold text-[var(--red)]">
                {current.score}%
              </div>
              <div className="text-[11px] font-semibold text-[var(--red)] mt-0.5 uppercase tracking-wider">
                match
              </div>
            </div>
          </div>

          {/* Why it matches */}
          <div className="mt-5 rounded-2xl bg-[#ecfdf5] border border-[#a7f3d0] p-4 text-xs">
            <p className="font-semibold text-[#059669] flex items-center gap-1.5">
              <Check size={14} className="stroke-[3]" />
              <span>Why it matches</span>
            </p>
            <p className="mt-1 text-[#065f46] leading-relaxed">
              {current.whyMatches}
            </p>
          </div>

          {/* What may be missing */}
          <div className="mt-3 rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-4 text-xs">
            <p className="font-semibold text-[#b45309]">What may be missing</p>
            <p className="mt-1 text-[#92400e] leading-relaxed">
              {current.missingItem}
            </p>
          </div>

          {/* Action Footer: [ See why it matches ]  [ Apply → ] */}
          <div className="mt-4 flex items-center gap-3 pt-2">
            <Link
              href={`/match/${current.id}`}
              className="flex-1 rounded-xl border border-[#F3E8E2] bg-white hover:bg-[#FFF1EA] text-[var(--ink)] text-xs font-semibold py-3 text-center transition-colors shadow-sm min-h-[44px] flex items-center justify-center"
            >
              See why it matches
            </Link>
            <Link
              href="/feed"
              className="flex-1 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-3 text-center transition-colors shadow-sm min-h-[44px] flex items-center justify-center gap-1.5"
            >
              <span>Apply →</span>
            </Link>
          </div>
        </div>
      </section>

      {/* 3. What is RemoteMatch? */}
      <section className="border-t border-[#F3E8E2] bg-white py-14 sm:py-16">
        <div className="container max-w-4xl text-center space-y-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--red)]">
            Product Overview
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-[var(--ink)]">
            A better way to search for remote jobs.
          </h2>
          <p className="text-base sm:text-lg text-[var(--muted)] leading-relaxed max-w-2xl mx-auto">
            RemoteMatch helps professionals find remote jobs that fit their experience and preferences. See why a job matches your background, understand what may be missing, and keep your applications organized in one place.
          </p>
        </div>
      </section>

      {/* 4. How it works */}
      <section id="how-it-works" className="border-t border-[#F3E8E2] bg-[#FFF7F2] py-16 sm:py-20">
        <div className="container">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--red)]">
              Workflow
            </span>
            <h2 className="mt-2 text-3xl font-bold text-[var(--ink)]">
              Find. Understand. Apply.
            </h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Four simple steps from first search to signing an offer.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                num: '01',
                title: "Tell us what you're looking for",
                desc: 'Set your role, location, and work preferences.',
              },
              {
                num: '02',
                title: 'See jobs that fit',
                desc: 'Discover remote opportunities relevant to your experience.',
              },
              {
                num: '03',
                title: 'Know what to check',
                desc: 'See what matches your background and what may need attention.',
              },
              {
                num: '04',
                title: 'Apply and keep track',
                desc: 'Apply through the employer and track applications, interviews, and offers in one place.',
              },
            ].map((step) => (
              <div
                key={step.num}
                className="rounded-3xl bg-white border border-[#F3E8E2] p-6 shadow-sm hover:border-[#fcd5dc] transition-colors"
              >
                <span className="mono text-xs font-bold text-[var(--red)]">
                  {step.num}
                </span>
                <h3 className="mt-4 font-bold text-base text-[var(--ink)] leading-snug">
                  {step.title}
                </h3>
                <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5. Free vs Pro Pricing Section */}
      <section id="pricing" className="border-t border-[#F3E8E2] bg-white py-16 sm:py-20">
        <div className="container max-w-4xl">
          <div className="text-center max-w-xl mx-auto mb-12">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--red)]">
              Plans & Access
            </span>
            <h2 className="mt-2 text-3xl font-bold text-[var(--ink)]">
              Simple, transparent pricing.
            </h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Get started for free or unlock unlimited saves and advanced filters with Pro.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Free Tier */}
            <div className="soft-card p-7 sm:p-8 rounded-3xl border border-[#F3E8E2] bg-white space-y-6">
              <div>
                <h3 className="text-xl font-bold text-[var(--ink)]">RemoteMatch Free</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">Get started for free.</p>
                <div className="mt-4 text-3xl font-bold text-[var(--ink)] mono">$0</div>
              </div>

              <ul className="space-y-3 text-xs text-[var(--muted)]">
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>15 saves per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>5 proposal generations per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Basic role & remote filters</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Application tracker</span>
                </li>
              </ul>

              <Link
                href="/feed"
                className="block w-full text-center rounded-xl border border-[#F3E8E2] bg-[#FFF1EA] hover:bg-white text-xs font-semibold text-[var(--ink)] py-3 transition-colors shadow-sm min-h-[44px]"
              >
                Start finding jobs →
              </Link>
            </div>

            {/* Pro Tier */}
            <div className="soft-card p-7 sm:p-8 rounded-3xl border-2 border-[var(--red)] bg-white space-y-6 relative shadow-md">
              <div className="absolute top-4 right-4 rounded-full bg-[#fdf2f4] text-[var(--red)] border border-[#fcd5dc] px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                Recommended
              </div>

              <div>
                <h3 className="text-xl font-bold text-[var(--ink)]">RemoteMatch Pro</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">More ways to find the right job.</p>
                <div className="mt-4 text-3xl font-bold text-[var(--ink)] mono">
                  $12 <span className="text-xs font-normal text-[var(--muted)]">/month</span>
                </div>
              </div>

              <ul className="space-y-3 text-xs text-[var(--ink)] font-medium">
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Unlimited saves</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Unlimited proposal materials</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Rewind accidental passes</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#059669] stroke-[3]" />
                  <span>Advanced salary, timezone & seniority filters</span>
                </li>
              </ul>

              <Link
                href="/settings?tab=billing"
                className="block w-full text-center rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-3 transition-colors shadow-sm min-h-[44px]"
              >
                Upgrade to Pro →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 6. AEO / Direct-Answer FAQ Section */}
      <section className="border-t border-[#F3E8E2] bg-[#FFF7F2] py-16 sm:py-20">
        <div className="container max-w-3xl">
          <div className="text-center mb-10">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--red)]">
              Frequently Asked Questions
            </span>
            <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-[var(--ink)]">
              Common Questions About RemoteMatch
            </h2>
          </div>

          <div className="space-y-4 text-xs">
            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                What is RemoteMatch?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                RemoteMatch is a remote job search platform that helps professionals discover remote jobs matched to their experience and preferences.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                We evaluate why an opportunity fits your background, identify requirements that may need attention, and help you track every application through to an offer.
              </p>
              <div>
                <Link href="/remote-jobs" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>Browse the remote jobs directory</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                How does RemoteMatch work?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                You tell us your role, seniority, and preferences, and we compare each remote job against your verified experience.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                Every opportunity displays a clear fit score, lists matching capabilities, and highlights potential gaps before you invest time applying.
              </p>
              <div>
                <Link href="/guide/how-remote-matching-works" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>Read our guide on how remote matching works</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                How do I find remote jobs that match my experience?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                You can browse curated categories in our public directory or create a profile to unlock personalized recommendations.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                Our match analysis examines technical frameworks, team scope, and timezone overlap rather than relying on automated keyword counting.
              </p>
              <div>
                <Link href="/onboarding" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>Find your matches now</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                Can I see why a remote job matches me?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                Yes. Every match view outlines why the role fits and what prerequisites might need attention.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                This insight gives you the exact context needed to highlight relevant achievements or tailor your application proposal.
              </p>
              <div>
                <Link href="/feed" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>Explore the live match feed</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                Can I track remote job applications?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                Yes. The built-in Application Tracker monitors every role through Applied, Screening, Interview, and Offer stages.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                You can save interview notes, log recruiter contacts, and keep your entire remote search organized in one dashboard.
              </p>
              <div>
                <Link href="/tracker" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>View the Application Tracker</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                Are all jobs on RemoteMatch 100% remote?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                Yes. RemoteMatch excludes hybrid roles requiring in-office attendance.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                Each listing clearly states geographic eligibility — whether it is Worldwide, US/Canada only, or European timezones.
              </p>
              <div>
                <Link href="/remote-jobs/worldwide" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>See worldwide remote roles</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-[#F3E8E2] p-5 shadow-sm space-y-2">
              <h3 className="font-bold text-sm text-[var(--ink)]">
                How often are job listings updated?
              </h3>
              <p className="font-medium text-[var(--ink)] leading-relaxed">
                Listings are validated daily. Confirmed closed positions are removed from the active directory and sitemap.
              </p>
              <p className="text-[var(--muted)] leading-relaxed">
                This guarantees you never spend time applying to expired openings that are no longer accepting applicants.
              </p>
              <div>
                <Link href="/remote-jobs" className="text-[var(--red)] font-semibold hover:underline inline-flex items-center gap-1">
                  <span>Explore active remote positions</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 7. Footer */}
      <footer className="border-t border-[#F3E8E2] py-10 bg-[#FFF1EA]">
        <div className="container flex flex-col gap-6 text-xs text-[var(--muted)]">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="font-bold text-base text-[var(--ink)]">RemoteMatch</span>
              <p className="text-[11px] text-[var(--muted)] max-w-xl leading-relaxed">
                RemoteMatch is a remote job search platform that helps professionals discover remote jobs matched to their experience and preferences, understand why a job fits, identify what may be missing, and track applications from application to offer.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs font-semibold shrink-0">
              <Link href="/remote-jobs" className="hover:text-[var(--ink)]">Directory</Link>
              <Link href="/guide" className="hover:text-[var(--ink)]">Guides</Link>
              <Link href="/feed" className="hover:text-[var(--ink)]">Jobs</Link>
              <Link href="/tracker" className="hover:text-[var(--ink)]">Applications</Link>
              <Link href="/settings" className="hover:text-[var(--ink)]">Profile</Link>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-[#F3E8E2]/80 pt-4 text-[11px]">
            <span className="font-semibold text-[var(--ink)]">
              Know your chances before you apply.
            </span>
            <span>© {new Date().getFullYear()} RemoteMatch. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
