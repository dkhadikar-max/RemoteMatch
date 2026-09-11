'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  CanonicalOpportunity,
  MatchAnalysisResult,
  TailoredResumeSuggestions,
  MaterialTone,
  CareerTransitionResult,
  ProfileIntent,
} from '@/types/byn';
import { CAREER_TRANSITION_COPY } from '@/lib/matching/career-transition';
import type { ActionableSkillGap } from '@/lib/match/actionable-skill-gaps';
import { WhatYouCanDo } from './what-you-can-do';
import { formatSalary } from '@/lib/feed/job-card-format';
import {
  sourceDisplayName,
  remoteScopeCaveat,
  salaryQualifierLabel,
  linkVerifiedLabel,
  employerDirectApplyLabel,
} from '@/lib/feed/trust-signals';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Check,
  Copy,
  Download,
  Printer,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  AlertCircle,
  Bookmark,
  Compass,
  ShieldCheck,
} from 'lucide-react';
import { DidYouApplyModal } from '../feedback/did-you-apply-modal';

/** Human phrasing for the years-of-experience bucket, for the "Your direction"
 *  line only. Never invents a number — mirrors the onboarding buckets. */
const YOE_PHRASE: Record<ProfileIntent['yearsOfExperience'], string> = {
  '0-1': 'under 2 years',
  '2-3': '2–3 years',
  '4-6': '4–6 years',
  '7-10': '7–10 years',
  '10+': '10+ years',
};

interface MatchAnalysisViewProps {
  opportunity: CanonicalOpportunity;
  match: MatchAnalysisResult;
  /** Career Transition Matching — present only for a `change_fields` user on an
   *  eligible, target-role-aligned role. Additive: does not change `match`.
   *  This analysis is FREE (V1.1); only discovering/filtering transition jobs
   *  in the feed is Pro. */
  careerTransition?: CareerTransitionResult | null;
  /** The user's years-of-experience bucket, for the "Your direction" line. */
  yearsOfExperience?: ProfileIntent['yearsOfExperience'];
  /** L3 — skill-shaped gaps derived independently of engine.ts (structured,
   *  never parsed from `match.gaps` sentence strings). Drives both "What may
   *  be missing" (column 2) and "What you can do". Additive; defaults to
   *  empty so this prop is optional for any other future caller. */
  actionableGaps?: ActionableSkillGap[];
  initialResumeTweaks: TailoredResumeSuggestions;
  initialCoverLetter: string;
  /** O3 — where each piece of material actually came from. Bullet rewrites
   *  never regenerate after the initial load (only the cover letter does,
   *  via tone changes), so they're tracked separately: 'ai' only when a
   *  real, anti-fabrication-checked model response is displayed; 'template'
   *  (the default) for the deterministic generator, including when an AI
   *  attempt existed but was rejected. Drives whether the panel claims
   *  "based strictly on your experience" or is honestly framed as generic
   *  guidance (see O3's copy split below). */
  resumeTweaksSource?: 'ai' | 'template';
  initialCoverLetterSource?: 'ai' | 'template';
  onToneChange?: (tone: MaterialTone) => Promise<{ coverLetter: string; source: 'ai' | 'template' }>;
  onRecordFeedback?: (didApply: any, notes?: string) => void;
  planTier?: 'free' | 'pro';
  dailyProposalsCount?: number;
  onRequireUpgrade?: (reason: 'proposals') => void;
}

const COMPANY_COLORS: Record<string, string> = {
  Linear: 'bg-[#5e6ad2] text-white',
  Stripe: 'bg-[#635bff] text-white',
  Mercury: 'bg-[#111827] text-white',
  Vercel: 'bg-black text-white',
  GitLab: 'bg-[#fc6d26] text-white',
  Automattic: 'bg-[#006088] text-white',
};

export function MatchAnalysisView({
  opportunity,
  match,
  careerTransition,
  yearsOfExperience,
  actionableGaps = [],
  initialResumeTweaks,
  initialCoverLetter,
  resumeTweaksSource = 'template',
  initialCoverLetterSource = 'template',
  onToneChange,
  onRecordFeedback,
  planTier = 'free',
  dailyProposalsCount = 0,
  onRequireUpgrade,
}: MatchAnalysisViewProps) {
  const [activeTab, setActiveTab] = useState<'analysis' | 'materials' | 'details' | 'company' | 'similar'>('analysis');
  const [activeTone, setActiveTone] = useState<MaterialTone>('confident');
  const [coverLetter, setCoverLetter] = useState(initialCoverLetter);
  const [coverLetterSource, setCoverLetterSource] = useState<'ai' | 'template'>(initialCoverLetterSource);
  const [copiedCoverLetter, setCopiedCoverLetter] = useState(false);
  const [copiedBulletIdx, setCopiedBulletIdx] = useState<number | null>(null);
  const [showApplyFeedbackModal, setShowApplyFeedbackModal] = useState(false);
  const [showApplicationReview, setShowApplicationReview] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  // L3/L2 — one shared source of truth for "which actionable gaps the user
  // has already answered this session" (either "Yes, add it" or "I don't
  // have this"), so "What may be missing" drops a row the instant the
  // sibling "What you can do" panel resolves it. `actionableGaps` itself is
  // still passed to <WhatYouCanDo> unfiltered — it tracks add/dismiss
  // per-row display (e.g. the dismissed reassurance line) independently.
  const [resolvedGapKeys, setResolvedGapKeys] = useState<Set<string>>(new Set());
  const remainingGaps = actionableGaps.filter((g) => !resolvedGapKeys.has(g.skillKey));
  // L1/L6(b) — the only "(Verified)" claim in the app is generated inside the
  // frozen engine.ts; engine.ts stays byte-for-byte untouched (this was an
  // explicit boundary), so the honest wording is substituted here, at render
  // time only, never at the source.
  const displayStrength = (s: string) => s.replace('(Verified)', '(from your profile)');

  const fitScore = match.fitScore;
  const fitLabel =
    match.fitBadge ?? (fitScore >= 80 ? 'Strong fit' : fitScore >= 65 ? 'Competitive' : 'Moderate fit');

  // Breakdown values derived from matching engine
  const roleScore = Math.min(98, Math.max(50, Math.round(fitScore * 0.98)));
  const skillsScore = Math.min(100, Math.max(45, Math.round(fitScore * 1.02)));
  const seniorityScore = Math.min(95, Math.max(60, fitScore - 3));
  const geographyScore = match.isCountryEligible && match.isRemoteEligible ? 100 : 40;
  const evidenceScore = Math.min(96, Math.max(50, fitScore - 4));

  const handleToneSelect = async (tone: MaterialTone) => {
    if (tone === activeTone) return;

    if (planTier === 'free' && dailyProposalsCount >= 5) {
      onRequireUpgrade?.('proposals');
      return;
    }

    if (onToneChange) {
      try {
        const result = await onToneChange(tone);
        if (result?.coverLetter) {
          setActiveTone(tone);
          setCoverLetter(result.coverLetter);
          setCoverLetterSource(result.source);
        }
      } catch (err: any) {
        if (err?.message === 'limit_reached' || err?.upgradeRequired) {
          onRequireUpgrade?.('proposals');
        } else {
          console.error('Failed to regenerate tone:', err);
        }
      }
    } else {
      setActiveTone(tone);
    }
  };

  const copyToClipboard = (text: string, isCoverLetter = false, bulletIdx?: number) => {
    navigator.clipboard.writeText(text);
    if (isCoverLetter) {
      setCopiedCoverLetter(true);
      setTimeout(() => setCopiedCoverLetter(false), 2500);
    } else if (bulletIdx !== undefined) {
      setCopiedBulletIdx(bulletIdx);
      setTimeout(() => setCopiedBulletIdx(null), 2500);
    }
  };

  const downloadTxt = () => {
    const content = `=====================================================
REMOTEMATCH MATCH SUMMARY: ${opportunity.company} — ${opportunity.title}
=====================================================

SCORE:
${fitScore} / 100 (${fitLabel})

WHY THIS SCORE:
Role alignment: ${roleScore}%
Technical skills: ${skillsScore}%
Seniority: ${seniorityScore}%
Geography: ${geographyScore}%
Experience match: ${evidenceScore}%

=====================================================
WHAT SUPPORTS THE MATCH:
${match.strengths.map((s) => `✓ ${s}`).join('\n')}

=====================================================
WHAT IS NOT PROVEN:
${match.gaps.map((g) => `! ${g}`).join('\n')}

=====================================================
BEFORE YOU APPLY:
${(match.jobSpecificResumeImprovements || [
  'Add concrete metrics demonstrating scale',
  'Clarify architectural ownership on your most recent project',
  'Make your remote async collaboration explicit',
])
  .map((item, i) => `0${i + 1}  ${typeof item === 'string' ? item : item.recommendation}`)
  .join('\n')}

=====================================================
APPLICATION PROPOSAL (${activeTone.toUpperCase()}):
=====================================================
${coverLetter}

=====================================================
RECOMMENDED BULLET ADJUSTMENTS:
=====================================================
${initialResumeTweaks.bulletRewrites
  .map((b) => `Target: ${b.targetRequirement}\nSuggested: ${b.suggestedRewrite}\nContext: ${b.originalContext}\n`)
  .join('\n')}
`;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${opportunity.company.replace(/\s+/g, '_')}_RemoteMatch_Summary.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleOfficialApplyClick = () => {
    window.open(opportunity.officialUrl, '_blank', 'noopener,noreferrer');
    setTimeout(() => {
      setShowApplyFeedbackModal(true);
    }, 1500);
  };

  const beforeYouApplySteps = match.jobSpecificResumeImprovements?.map((imp) =>
    typeof imp === 'string' ? imp : imp.recommendation || imp.title
  ) || [
    'Add production-scale impact metrics to your recent role',
    'Clarify architectural ownership and distributed systems scope',
    'Make remote async workflow and cross-functional decisions explicit',
  ];

  const badgeColor = COMPANY_COLORS[opportunity.company] || 'bg-[var(--ink)] text-white';

  return (
    <main className="page py-8 px-4 sm:px-6">
      <div className="container max-w-5xl space-y-6">
        {/* Navigation */}
        <div className="no-print">
          <Link
            href="/feed"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            <ArrowLeft size={14} />
            <span>← Back to jobs</span>
          </Link>
        </div>

        {/* Top Header Card (Screen 3) */}
        <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)] rounded-3xl">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className={`grid size-12 shrink-0 place-items-center rounded-2xl font-bold text-base shadow-sm ${badgeColor}`}>
                {opportunity.company.charAt(0)}
              </div>
              <div>
                <span className="text-xs font-semibold text-[var(--muted)] tracking-wide">
                  {opportunity.company} · Remote ({opportunity.remoteType === 'Worldwide' ? 'Worldwide' : opportunity.remoteType || 'Eligible'})
                </span>
                <div className="flex items-center gap-3 mt-1">
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--ink)]">
                    Should you apply?
                  </h1>
                  <span className="text-xs text-[var(--muted)]">({opportunity.title})</span>
                </div>
                {/* M10.2 — this line used to fabricate "$140k – $180k ·
                    Full-time" whenever salary was missing, the exact class of
                    fabrication H removed from job-card.tsx / job-details-modal.tsx.
                    Fixed here using H's own shared formatSalary() (no new
                    formatter, no new computation) and the opportunity's real
                    employmentType. M3's salary qualifier is attached inline. */}
                <p className="text-xs text-[var(--muted)] mt-1 font-mono font-medium flex items-center gap-1.5 flex-wrap">
                  <span>{formatSalary(opportunity)} · {opportunity.employmentType}</span>
                  {salaryQualifierLabel(opportunity) && (
                    <span className="text-[10px] font-sans font-semibold text-[var(--muted)] bg-[var(--surface-soft)] border border-[var(--line)] rounded-full px-1.5 py-0.5">
                      {salaryQualifierLabel(opportunity)}
                    </span>
                  )}
                </p>
                {/* M — Job Trust Layer: provenance, remote-scope honesty,
                    link freshness, employer-direct reassurance. Same helpers
                    and same facts as job-details-modal.tsx; additive, applies
                    across every tab (placed above the tab bar). */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[10px] text-[var(--muted)]">
                  <span>{sourceDisplayName(opportunity.source)}</span>
                  {linkVerifiedLabel(opportunity.linkCheckedAt) && (
                    <>
                      <span>·</span>
                      <span>{linkVerifiedLabel(opportunity.linkCheckedAt)}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{remoteScopeCaveat(opportunity.explicitRemoteScope)}</span>
                  {employerDirectApplyLabel(opportunity.source) && (
                    <>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck size={10} className="text-[#059669]" />
                        {employerDirectApplyLabel(opportunity.source)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Right Action Buttons: [ Save ]  [ Apply → ] */}
            <div className="flex items-center gap-2.5 self-end sm:self-center no-print">
              <button
                type="button"
                onClick={() => setIsSaved(!isSaved)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-xs font-semibold text-[var(--ink)] px-4 py-2.5 transition-colors shadow-sm min-h-[44px]"
              >
                <Bookmark size={14} className={isSaved ? 'fill-[var(--red)] text-[var(--red)]' : ''} />
                <span>{isSaved ? 'Saved' : 'Save'}</span>
              </button>

              <button
                type="button"
                onClick={handleOfficialApplyClick}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-5 py-2.5 transition-colors shadow-sm min-h-[44px]"
              >
                <span>Apply →</span>
              </button>
            </div>
          </div>

          {/* Navigation Tabs (Screen 3) */}
          <div className="flex items-center gap-2 border-b border-[var(--line)] pb-3 pt-2 text-xs">
            <button
              onClick={() => setActiveTab('analysis')}
              className={`px-3.5 py-1.5 rounded-full font-semibold transition-colors min-h-[36px] ${
                activeTab === 'analysis'
                  ? 'bg-[var(--red)] text-white shadow-sm'
                  : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
              }`}
            >
              Match Analysis
            </button>
            <button
              onClick={() => {
                setActiveTab('materials');
                setShowApplicationReview(true);
              }}
              className={`px-3.5 py-1.5 rounded-full font-semibold transition-colors min-h-[36px] ${
                activeTab === 'materials'
                  ? 'bg-[var(--red)] text-white shadow-sm'
                  : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
              }`}
            >
              Application Materials
            </button>
            <button
              onClick={() => setActiveTab('details')}
              className={`px-3.5 py-1.5 rounded-full font-semibold transition-colors ${
                activeTab === 'details'
                  ? 'bg-[var(--red)] text-white shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              Job details
            </button>
            <button
              onClick={() => setActiveTab('company')}
              className={`px-3.5 py-1.5 rounded-full font-semibold transition-colors ${
                activeTab === 'company'
                  ? 'bg-[var(--red)] text-white shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              Company
            </button>
            <button
              onClick={() => setActiveTab('similar')}
              className={`px-3.5 py-1.5 rounded-full font-semibold transition-colors ${
                activeTab === 'similar'
                  ? 'bg-[var(--red)] text-white shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              Similar roles
            </button>
          </div>

          {activeTab === 'analysis' && (
            <>
              {/* Score & Breakdown Overview (Screen 3) */}
              <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8 items-center pt-2">
                {/* Circular Score Dial */}
                <div className="flex flex-col items-center justify-center p-5 rounded-2xl bg-[var(--red-soft)] border border-[var(--red-soft-border)] text-center">
                  <div className="relative size-28 flex items-center justify-center">
                    <svg className="size-full -rotate-90" viewBox="0 0 36 36">
                      <path
                        className="text-[var(--red-soft-border)]"
                        strokeWidth="3.5"
                        stroke="currentColor"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                      <path
                        className="text-[var(--red)]"
                        strokeDasharray={`${fitScore}, 100`}
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        stroke="currentColor"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="mono text-3xl font-bold text-[var(--red)] leading-none">
                        {fitScore}%
                      </span>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-[var(--red)] mt-3">
                    {fitScore >= 80 ? 'Strong match' : fitLabel}
                  </span>
                  <span className="text-[11px] text-[var(--muted)] mt-0.5">
                    Based on your profile
                  </span>
                  {(fitScore >= 80 || fitLabel.toLowerCase().includes('strong')) && (
                    <p className="text-xs font-medium text-[var(--ink)] mt-2 px-1">
                      This looks like a strong match for you.
                    </p>
                  )}
                </div>

                {/* Horizontal Progress Bars: Why It Fits */}
                <div className="space-y-3.5">
                  <h2 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
                    Why it fits
                  </h2>

                  <div className="space-y-3">
                    {[
                      { label: 'Role alignment', score: roleScore },
                      { label: 'Core skills', score: skillsScore },
                      { label: 'Experience level', score: seniorityScore },
                      { label: 'Location & eligibility', score: geographyScore },
                      { label: 'Experience match', score: evidenceScore },
                    ].map((factor) => (
                      <div key={factor.label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-[var(--ink)]">{factor.label}</span>
                          <span className="mono font-semibold text-[var(--red)]">{factor.score}%</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--red)] rounded-full transition-all duration-300"
                            style={{ width: `${factor.score}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* L4 — whyThisJob already existed on the returned
                  MatchAnalysisResult, computed by the frozen engine, and was
                  never rendered anywhere. Zero new computation: shown
                  verbatim. */}
              {match.whyThisJob && (
                <div className="rounded-2xl bg-[var(--surface-soft)] border border-[var(--line)] px-4 py-3">
                  <p className="text-xs text-[var(--ink)] leading-relaxed">{match.whyThisJob}</p>
                </div>
              )}

              {/* Career Transition — additive, FREE explanation for a career
                  changer. "Why this could fit" shows the USER's own confirmed
                  skills (never the job's requirement names); gaps are listed
                  requirements the profile doesn't demonstrate. Never restates
                  the fit score as a qualification. */}
              {careerTransition && (
                <div className="mt-4 rounded-3xl border border-[var(--red-soft-border)] bg-[var(--red-soft)] p-5 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--red)] uppercase tracking-wider">
                    <Compass size={15} />
                    <span>Career transition · {CAREER_TRANSITION_COPY[careerTransition.classification].label}</span>
                  </div>
                  <p className="text-xs text-[var(--ink)] leading-relaxed">
                    {CAREER_TRANSITION_COPY[careerTransition.classification].blurb}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-[#ecfdf5] border border-[#a7f3d0] p-3 space-y-1.5">
                      <span className="text-[11px] font-bold text-[#059669] uppercase tracking-wider">Why this could fit</span>
                      {careerTransition.transferableSkills.length > 0 ? (
                        <p className="text-xs text-[var(--ink)] leading-snug">
                          Your experience with{' '}
                          <span className="font-semibold">{careerTransition.transferableSkills.join(', ')}</span>{' '}
                          carries into this role.
                        </p>
                      ) : (
                        <p className="text-xs text-[var(--muted)] leading-snug">
                          Your target field aligns with this role — the skills below are where to focus.
                        </p>
                      )}
                    </div>
                    <div className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3 space-y-1.5">
                      <span className="text-[11px] font-bold text-[#b45309] uppercase tracking-wider">What may be missing</span>
                      {careerTransition.potentialGaps.length > 0 ? (
                        <p className="text-xs text-[var(--ink)] leading-snug">{careerTransition.potentialGaps.join(', ')}</p>
                      ) : (
                        <p className="text-xs text-[var(--muted)] leading-snug">No obvious skill gaps against the listed requirements.</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--red-soft-border)] p-3 space-y-1">
                    <span className="text-[11px] font-bold text-[var(--red)] uppercase tracking-wider">Your direction</span>
                    <p className="text-xs text-[var(--ink)] leading-snug">
                      You&rsquo;re moving into <span className="font-semibold">{careerTransition.targetRole}</span> roles
                      {yearsOfExperience ? `, with ${YOE_PHRASE[yearsOfExperience]} of experience in your current field` : ''}.
                    </p>
                  </div>
                  <p className="text-[11px] text-[var(--muted)] leading-snug">
                    Based on the skills and experience in your profile.
                  </p>
                </div>
              )}

              {/* 3-Column Decision Grid (Screen 3) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-4">
                {/* Column 1: Why it fits (Green) */}
                <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5 space-y-4 shadow-sm">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--ink)] uppercase tracking-wider pb-2 border-b border-[var(--line)]">
                    <CircleCheck size={16} className="text-[#059669]" />
                    <span>Why it fits</span>
                  </div>

                  <div className="space-y-2.5">
                    {match.strengths.slice(0, 4).map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 rounded-2xl bg-[#ecfdf5] border border-[#a7f3d0] p-3 text-xs"
                      >
                        <Check size={14} className="text-[#059669] stroke-[3] shrink-0 mt-0.5" />
                        <span className="font-medium text-[var(--ink)] leading-snug">{displayStrength(item)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Column 2: What may be missing (Amber) */}
                <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5 space-y-4 shadow-sm">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#b45309] uppercase tracking-wider pb-2 border-b border-[var(--line)]">
                    <AlertCircle size={16} className="text-[#b45309]" />
                    <span>What may be missing</span>
                  </div>

                  <div className="space-y-2.5">
                    {/* L3 — structured, skill-shaped gaps derived independently of
                        engine.ts (never parsed from match.gaps sentence strings).
                        A row disappears here the moment "What you can do" below
                        resolves it, either way. */}
                    {remainingGaps.map((gap) => (
                      <div
                        key={gap.skillKey}
                        className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3 text-xs space-y-1"
                      >
                        <p className="font-semibold text-[#b45309]">{gap.skill}</p>
                        <p className="text-[#92400e] text-[11px] leading-relaxed">
                          {gap.skill} isn&rsquo;t currently part of your profile.
                        </p>
                      </div>
                    ))}
                    {/* Structural (non-actionable — nothing to "add") caveat,
                        derived from the same booleans engine.ts already returns. */}
                    {(!match.isCountryEligible || !match.isRemoteEligible) && (
                      <div className="rounded-2xl bg-[#fffbeb] border border-[#fde68a] p-3 text-xs space-y-1">
                        <p className="font-semibold text-[#b45309]">Location or remote-eligibility restriction</p>
                        <p className="text-[#92400e] text-[11px] leading-relaxed">
                          This role has a {opportunity.remoteType || 'remote-eligibility'} restriction that may
                          affect your eligibility.
                        </p>
                      </div>
                    )}
                    {remainingGaps.length === 0 && match.isCountryEligible && match.isRemoteEligible && (
                      <div className="rounded-2xl bg-[var(--surface-soft)] p-4 text-xs text-[var(--muted)]">
                        All core requirements match your profile.
                      </div>
                    )}
                  </div>
                </div>

                {/* Column 3: Before you apply (Numbered Red Circles) */}
                <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5 space-y-4 shadow-sm flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider pb-2 border-b border-[var(--line)]">
                      Before you apply
                    </div>
                    <p className="text-[11px] text-[var(--muted)] mt-2">
                      Review this requirement and highlight relevant experience if you have it.
                    </p>

                    <div className="space-y-3 mt-3">
                      {beforeYouApplySteps.slice(0, 3).map((step, idx) => (
                        <div key={idx} className="flex items-start gap-3 text-xs">
                          <span className="grid size-5 place-items-center rounded-full bg-[var(--red-soft)] border border-[var(--red-soft-border)] text-[11px] font-bold text-[var(--red)] shrink-0 mt-0.5">
                            {idx + 1}
                          </span>
                          <span className="font-medium text-[var(--ink)] leading-snug">{step}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowApplicationReview(!showApplicationReview)}
                    className="w-full mt-4 rounded-xl bg-[var(--red-soft)] hover:bg-[var(--red-soft-border)] text-[var(--red)] border border-[var(--red-soft-border)] text-xs font-semibold py-2.5 px-3 transition-colors flex items-center justify-center gap-1.5 min-h-[44px]"
                  >
                    <span>Tailored application materials</span>
                    {showApplicationReview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>

              {/* L2/L3 — "What you can do": the same confirm-before-add
                  contract as ticket I ("Do you have X? Yes, add it / I don't
                  have this"), wired to I's exact two existing routes. No new
                  skills/dismissal mechanism. */}
              {actionableGaps.length > 0 && (
                <div className="pt-1">
                  <WhatYouCanDo
                    gaps={actionableGaps}
                    onResolved={(skillKey) =>
                      setResolvedGapKeys((prev) => {
                        const next = new Set(prev);
                        next.add(skillKey);
                        return next;
                      })
                    }
                  />
                </div>
              )}
            </>
          )}

          {activeTab === 'details' && (
            <div className="space-y-4 pt-2 text-xs text-[var(--ink)] leading-relaxed">
              <h3 className="font-semibold text-sm">Required Qualifications & Scope</h3>
              <p>{opportunity.description || 'Full description retrieved from official employer listing.'}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                {opportunity.requiredSkills.map((s) => (
                  <span key={s} className="tag">{s}</span>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'company' && (
            <div className="space-y-4 pt-2 text-xs text-[var(--ink)] leading-relaxed">
              <h3 className="font-semibold text-sm">About {opportunity.company}</h3>
              <p>Remote-friendly organization with verified distributed hiring eligibility.</p>
              <div className="p-4 rounded-2xl bg-[var(--surface-soft)] border border-[var(--line)] space-y-1">
                <p><strong>Primary Remote Policy:</strong> {opportunity.remoteType || 'Worldwide'}</p>
                <p><strong>Compensation Range:</strong> ${Math.round((opportunity.salaryMin || 0)/1000)}k – ${Math.round((opportunity.salaryMax || 0)/1000)}k USD</p>
              </div>
            </div>
          )}

          {activeTab === 'similar' && (
            <div className="space-y-3 pt-2 text-xs">
              <p className="text-[var(--muted)]">Explore similar opportunities aligned with your experience:</p>
              <div className="flex gap-2">
                <Link href="/feed" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold hover:bg-[var(--surface-soft)] min-h-[44px] flex items-center">
                  View More in Feed →
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Expandable Application Materials Drawer */}
        {(showApplicationReview || activeTab === 'materials') && (
          <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)] rounded-3xl animate-in fade-in duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--line)]">
              <div>
                <h2 className="text-sm font-bold text-[var(--ink)] uppercase tracking-wider">
                  Tailored Application Materials
                </h2>
                {/* O3 — this claim is only true when resumeTweaksSource is
                    'ai' (a real, anti-fabrication-checked model response).
                    The deterministic template — the default for every user,
                    and the only content free users without a real resume on
                    file will ever see — is honestly framed as generic
                    guidance, never as evidence drawn from the user. */}
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  {resumeTweaksSource === 'ai'
                    ? 'Tailored suggestions based strictly on your experience'
                    : 'General guidance based on this role’s requirements — personalize it with your own real experience before sending'}
                </p>
              </div>
              <span className={`status text-[11px] ${resumeTweaksSource === 'ai' ? 'good' : ''}`}>
                {resumeTweaksSource === 'ai' ? 'Tailored for you' : 'Generic guidance'}
              </span>
            </div>

            {/* Bullet Rewrites */}
            <div>
              <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider mb-3">
                Tailored Bullet Adjustments
              </h3>
              <div className="space-y-3">
                {initialResumeTweaks.bulletRewrites.map((bullet, idx) => (
                  <div
                    key={idx}
                    className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[var(--ink)]">
                        Target: {bullet.targetRequirement}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(bullet.suggestedRewrite, false, idx)}
                        className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] transition-colors min-h-[32px]"
                      >
                        {copiedBulletIdx === idx ? (
                          <>
                            <Check size={12} className="text-[#059669]" />
                            <span className="text-[#059669] font-medium">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                    <p className="bg-[var(--surface)] p-3 rounded-xl border border-[var(--line)] text-xs text-[var(--ink)] leading-relaxed font-mono">
                      "{bullet.suggestedRewrite}"
                    </p>
                    {/* O3 — never labeled "Source Fact" for generic template
                        content: originalContext there is a hardcoded example,
                        not anything drawn from this user. */}
                    <span className="text-[11px] text-[var(--muted)] block">
                      {resumeTweaksSource === 'ai'
                        ? `Source Fact: ${bullet.originalContext}`
                        : 'Typical starting point — replace with specifics from your own background.'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Proposal Letter */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center">
                  <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
                    Tailored Proposal Letter
                  </h3>
                  {/* O3 — the cover letter can independently be 'ai' or
                      'template' after a tone change, regardless of the
                      bullets' source above. */}
                  {coverLetterSource !== 'ai' && (
                    <span className="text-[10px] font-semibold text-[var(--muted)] ml-2 bg-[var(--surface-soft)] border border-[var(--line)] rounded-full px-1.5 py-0.5">
                      Generic starting point
                    </span>
                  )}
                  {planTier === 'free' ? (
                    <span className="text-[11px] text-[var(--muted)] ml-2">
                      ({dailyProposalsCount} of 5 used today)
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#059669] font-semibold ml-2">
                      (Unlimited · Pro)
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 text-xs">
                  {(['confident', 'conversational', 'formal'] as MaterialTone[]).map((tone) => (
                    <button
                      key={tone}
                      type="button"
                      onClick={() => handleToneSelect(tone)}
                      className={`px-3 py-1.5 text-xs capitalize rounded-xl transition-colors min-h-[36px] ${
                        activeTone === tone
                          ? 'bg-[var(--red)] text-white font-semibold shadow-sm'
                          : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {tone}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <textarea
                  value={coverLetter}
                  onChange={(e) => setCoverLetter(e.target.value)}
                  rows={8}
                  className="soft-input resize-none text-xs leading-relaxed font-mono border-[var(--line)]"
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(coverLetter, true)}
                  className="absolute top-3 right-3 flex items-center gap-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] shadow-sm min-h-[32px]"
                >
                  {copiedCoverLetter ? (
                    <>
                      <Check size={12} className="text-[#059669]" />
                      <span className="text-[#059669] font-medium">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Safety Note */}
        <p className="text-xs text-[var(--muted)] text-center pb-4">
          Direct application to employer. No personal identifying information is transmitted to third parties.
        </p>
      </div>

      {/* Feedback Outcome Modal */}
      {showApplyFeedbackModal && (
        <DidYouApplyModal
          isOpen={showApplyFeedbackModal}
          companyName={opportunity.company}
          onClose={() => setShowApplyFeedbackModal(false)}
          onSubmitFeedback={(outcome, notes) => {
            if (onRecordFeedback) {
              onRecordFeedback(outcome, notes);
            }
            setShowApplyFeedbackModal(false);
          }}
        />
      )}
    </main>
  );
}
