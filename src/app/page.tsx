'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Compass,
  Sparkles,
  ShieldCheck,
  FileCheck,
  CheckCircle2,
  ArrowRight,
  Zap,
  Globe,
  DollarSign,
  Heart,
  X,
  Layers,
} from 'lucide-react';
import { CanonicalOpportunity } from '@/types/byn';

// 3 Interactive Demo Opportunities for instant preview
const DEMO_PREVIEW_JOBS: CanonicalOpportunity[] = [
  {
    id: 'demo-p-1',
    type: 'job',
    title: 'Senior Full Stack Engineer',
    company: 'Automattic',
    companyLogo: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100&h=100&fit=crop&crop=faces',
    description: 'Build globally scalable web architectures across WordPress.com and Tumblr with React, TypeScript, and distributed databases.',
    source: 'curated',
    sourceId: 'demo-1',
    officialUrl: 'https://automattic.com/work-with-us',
    canonicalUrlHash: 'h1',
    contentHash: 'c1',
    employmentType: 'Full-time',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    salaryMin: 120000,
    salaryMax: 160000,
    requiredSkills: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
    preferredSkills: [],
    qualityScore: 95,
    status: 'active',
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    fitScore: 88,
    fitBadge: 'Strong Fit',
  },
  {
    id: 'demo-p-2',
    type: 'job',
    title: 'Staff Product Designer',
    company: 'GitLab',
    companyLogo: 'https://images.unsplash.com/photo-1572044162444-ad60f128bdea?w=100&h=100&fit=crop&crop=faces',
    description: 'Lead design systems, developer workflows, and end-to-end Figma UI components across our global asynchronous remote organization.',
    source: 'curated',
    sourceId: 'demo-2',
    officialUrl: 'https://about.gitlab.com/jobs/apply',
    canonicalUrlHash: 'h2',
    contentHash: 'c2',
    employmentType: 'Full-time',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    salaryMin: 140000,
    salaryMax: 185000,
    requiredSkills: ['Figma', 'Product Design', 'Design Systems', 'SaaS'],
    preferredSkills: [],
    qualityScore: 92,
    status: 'active',
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    fitScore: 84,
    fitBadge: 'Strong Fit',
  },
  {
    id: 'demo-p-3',
    type: 'job',
    title: 'Freelance AI/ML Engineer',
    company: 'HyperScale AI Lab',
    companyLogo: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=100&h=100&fit=crop&crop=faces',
    description: 'Design retrieval-augmented generation (RAG) pipelines, evaluate embeddings, and optimize open models with PyTorch and Python.',
    source: 'curated',
    sourceId: 'demo-3',
    officialUrl: 'https://hyperscale.ai/contracts',
    canonicalUrlHash: 'h3',
    contentHash: 'c3',
    employmentType: 'Contract',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    salaryMin: 70,
    salaryMax: 110,
    requiredSkills: ['Python', 'PyTorch', 'LLMs', 'RAG', 'Vector DBs'],
    preferredSkills: [],
    qualityScore: 90,
    status: 'active',
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    fitScore: 79,
    fitBadge: 'Good Fit',
  },
];

export default function LandingPage() {
  const [demoDeck, setDemoDeck] = useState(DEMO_PREVIEW_JOBS);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [interestedJob, setInterestedJob] = useState<CanonicalOpportunity | null>(null);

  const currentJob = demoDeck[0];

  const handleDemoAction = (action: 'pass' | 'interested') => {
    if (!currentJob) return;
    if (action === 'interested') {
      setInterestedJob(currentJob);
      setShowSignupPrompt(true);
    }
    setDemoDeck((prev) => prev.slice(1));
  };

  return (
    <div className="flex flex-col items-center w-full min-h-[calc(100vh-4rem)]">
      {/* Hero Section */}
      <section className="relative w-full max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-20 text-center flex flex-col items-center">
        {/* Glow backdrop */}
        <div className="pointer-events-none absolute top-10 left-1/2 -translate-x-1/2 h-72 w-96 rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="pointer-events-none absolute top-20 left-1/3 -translate-x-1/2 h-64 w-80 rounded-full bg-indigo-500/10 blur-[100px]" />

        {/* Pill Tag */}
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-xs font-semibold text-emerald-400 mb-6 shadow-sm">
          <Sparkles className="h-3.5 w-3.5" />
          <span>BYN Architecture: Know your chances before you apply</span>
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-foreground max-w-4xl leading-[1.12]">
          Know your chances{' '}
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-indigo-400 bg-clip-text text-transparent">
            before you apply.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-5 text-base sm:text-lg text-muted-foreground max-w-2xl leading-relaxed">
          Upload your resume. Tell us what you're looking for. Swipe through remote opportunities. See exactly why you're a match, what's missing, and how to strengthen your application before you apply on the official website.
        </p>

        {/* CTAs */}
        <div className="mt-8 flex flex-col sm:flex-row items-center gap-4">
          <Link
            href="/onboarding"
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-sm font-bold text-white shadow-xl shadow-emerald-500/25 hover:bg-emerald-600 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <span>Set Intent & Upload Resume</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/feed"
            className="flex items-center justify-center gap-2 rounded-xl border border-border bg-secondary/80 px-6 py-3.5 text-sm font-semibold text-foreground hover:bg-secondary transition-all"
          >
            <span>Jump to Live Feed</span>
          </Link>
        </div>

        {/* Interactive 3-Card Preview Demo */}
        <div className="mt-16 w-full max-w-md flex flex-col items-center">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            <span>Interactive Demo: Try Swiping Below</span>
          </div>

          {currentJob ? (
            <div className="relative w-full rounded-2xl border border-border bg-card p-6 shadow-2xl text-left space-y-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={currentJob.companyLogo}
                    alt={currentJob.company}
                    className="h-11 w-11 rounded-xl object-cover border border-border bg-secondary"
                  />
                  <div>
                    <h3 className="font-bold text-sm text-foreground">
                      {currentJob.company}
                    </h3>
                    <span className="text-[11px] text-muted-foreground">
                      {currentJob.remoteType}
                    </span>
                  </div>
                </div>

                {/* Fit Score Badge */}
                <div className="flex flex-col items-end rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-400">
                  <span className="text-xs font-bold">FIT {currentJob.fitScore}%</span>
                  <span className="text-[9px] font-medium">{currentJob.fitBadge}</span>
                </div>
              </div>

              <div>
                <h4 className="text-base font-bold text-foreground">
                  {currentJob.title}
                </h4>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {currentJob.description}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5 pt-1">
                {currentJob.requiredSkills.map((sk, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground border border-border"
                  >
                    {sk}
                  </span>
                ))}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => handleDemoAction('pass')}
                  className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/20 transition-all"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Pass</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDemoAction('interested')}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-all"
                >
                  <Heart className="h-3.5 w-3.5 fill-white" />
                  <span>Interested</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full p-8 rounded-2xl border border-border bg-card text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto" />
              <h4 className="font-bold text-base text-foreground">Demo Deck Completed</h4>
              <p className="text-xs text-muted-foreground">
                Set up your profile to swipe all verified remote opportunities tailored to your exact skills.
              </p>
              <Link
                href="/onboarding"
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2 text-xs font-bold text-white hover:bg-emerald-600 transition-colors"
              >
                <span>Get Started (60 seconds)</span>
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* Feature Pillar Grid */}
      <section className="w-full max-w-6xl px-4 py-16 sm:px-6 border-t border-border">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            The Moat is High-Signal Intelligence
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            The swipe UI is just the interface. Our 3-layer matching engine does the heavy lifting so you only apply where you have a genuine advantage.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1 */}
          <div className="p-6 rounded-2xl border border-border bg-card shadow-sm space-y-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              Hard Eligibility Gating
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We never show you a 92% match for a job restricted to another country. Work scope, timezones, and employment types are verified before computing fit.
            </p>
          </div>

          {/* Card 2 */}
          <div className="p-6 rounded-2xl border border-border bg-card shadow-sm space-y-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              Explainable Match Analysis
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Never guess why a job appeared. Get clear "Why You're Seeing This" explanations, granular strengths vs gaps, and requirement checklists.
            </p>
          </div>

          {/* Card 3 */}
          <div className="p-6 rounded-2xl border border-border bg-card shadow-sm space-y-3">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
              <FileCheck className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              Instant Application Kit
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Get recommended resume bullet rewrites and a concise cover letter tailored to your chosen tone (confident, conversational, formal).
            </p>
          </div>
        </div>
      </section>

      {/* Demo Sign-up Prompt Modal */}
      {showSignupPrompt && interestedJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative flex flex-col w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-foreground">
                  Personalize Your Match Analysis
                </h3>
                <span className="text-xs text-muted-foreground">
                  Ready to unlock your tailored materials for {interestedJob.company}?
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              Complete your quick 60-second onboarding to upload your resume. RemoteMatch will extract your skills, compute your exact Fit Score, and generate your custom cover letter.
            </p>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowSignupPrompt(false)}
                className="flex-1 rounded-xl border border-border bg-secondary px-4 py-2.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-colors"
              >
                Keep Exploring
              </button>
              <Link
                href="/onboarding"
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-colors"
              >
                <span>Continue to Onboarding</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
