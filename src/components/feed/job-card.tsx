'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import { formatPostedAge, formatSalary } from '@/lib/feed/job-card-format';
import Link from 'next/link';
import { ArrowUpRight, BriefcaseBusiness, CalendarDays, Check, Clock3, Globe2, Layers3, Sparkles, Wallet } from 'lucide-react';
import { matchHref } from '@/lib/match/match-href';
import { trackApplyClick } from '@/lib/funnel/client';

interface JobCardProps {
  opportunity: CanonicalOpportunity;
  onOpenDetails?: () => void;
  isFrontCard?: boolean;
}

const COMPANY_COLORS: Record<string, string> = {
  Linear: 'bg-[#5e6ad2] text-white',
  Stripe: 'bg-[#635bff] text-white',
  Mercury: 'bg-[#111827] text-white',
  Vercel: 'bg-black text-white',
  GitLab: 'bg-[#fc6d26] text-white',
  Automattic: 'bg-[#006088] text-white',
};

export function JobCard({ opportunity, onOpenDetails, isFrontCard = true }: JobCardProps) {
  const fitScore = typeof opportunity.fitScore === 'number' ? opportunity.fitScore : null;
  const hasSkillMatch = typeof opportunity.skillsMatchedCount === 'number' &&
    typeof opportunity.skillsTotalCount === 'number';
  const displayTags = opportunity.requiredSkills.slice(0, 4);
  const remainingCount = Math.max(opportunity.requiredSkills.length - displayTags.length, 0);
  const badgeColor = COMPANY_COLORS[opportunity.company] || 'bg-slate-900 text-white';
  const remoteScope = opportunity.remoteType === 'Worldwide' ? 'Worldwide' : opportunity.remoteType || 'Eligible';
  const salary = formatSalary(opportunity);
  const postedAge = formatPostedAge(opportunity.postedAt);
  const scopeLine = ['Remote', remoteScope, opportunity.employmentType].filter(Boolean).join(' · ');
  const matchTone = fitScore !== null && fitScore >= 80
    ? 'text-emerald-800 bg-emerald-50 border-emerald-100'
    : 'text-amber-800 bg-amber-50 border-amber-100';

  return (
    <article className="relative flex min-h-[520px] w-full max-w-[820px] flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white text-slate-950 shadow-[0_16px_50px_rgba(15,23,42,0.08)] transition-shadow duration-200 hover:shadow-[0_20px_60px_rgba(15,23,42,0.12)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-r from-orange-50 via-white to-violet-50 opacity-90" />
      <div className="relative flex flex-1 flex-col p-5 sm:p-7 lg:p-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className={`grid size-14 shrink-0 place-items-center rounded-2xl text-xl font-extrabold shadow-sm ring-1 ring-black/5 ${badgeColor}`}>
              {opportunity.company.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-bold tracking-tight text-slate-900">{opportunity.company}</span>
                <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Opportunity</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{scopeLine}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {fitScore !== null && (
              <div className={`flex min-w-[92px] flex-col items-center rounded-2xl border px-3 py-2 ${matchTone}`}>
                <span className="text-[26px] font-extrabold leading-none tracking-tight">{fitScore}%</span>
                <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.16em]">Match</span>
              </div>
            )}
            {opportunity.fitBadge && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-800">{opportunity.fitBadge}</span>
            )}
          </div>
        </div>

        <div className="mt-7">
          <h2 className="max-w-3xl text-[25px] font-extrabold leading-[1.12] tracking-[-0.035em] text-slate-950 sm:text-[32px]">
            {opportunity.title}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium text-slate-500">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700"><Wallet size={14} />{salary || 'Salary not disclosed'}</span>
            <span className="inline-flex items-center gap-1.5"><Globe2 size={14} />{remoteScope}</span>
            <span className="inline-flex items-center gap-1.5"><BriefcaseBusiness size={14} />{opportunity.employmentType}</span>
            {opportunity.experienceRequirement && <span className="inline-flex items-center gap-1.5"><Clock3 size={14} />{opportunity.experienceRequirement}</span>}
            {postedAge && <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} />{postedAge}</span>}
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50/90 p-4">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400"><Layers3 size={12}/> Key requirements</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {displayTags.length > 0 ? displayTags.map((tag) => (
                <span key={tag} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700">{tag}</span>
              )) : <span className="text-xs text-slate-500">See role description</span>}
              {remainingCount > 0 && <span className="rounded-lg bg-slate-200/70 px-2 py-1 text-[11px] font-semibold text-slate-600">+{remainingCount}</span>}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <span className="grid size-7 place-items-center rounded-lg bg-white text-emerald-700 shadow-sm"><Sparkles size={15}/></span>
              {fitScore !== null ? 'Your match breakdown' : 'Role requirements'}
            </div>
            {fitScore !== null ? (
              <>
                <div className="mt-3 flex items-center justify-between text-xs font-semibold text-emerald-900">
                  <span>{hasSkillMatch ? `${opportunity.skillsMatchedCount} of ${opportunity.skillsTotalCount} skills matched` : 'Screening fit score'}</span>
                  <span>{fitScore}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-100">
                  <div className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-teal-500" style={{ width: `${Math.max(0, Math.min(100, fitScore))}%` }} />
                </div>
                <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-emerald-950">
                  <Check size={14} className="mt-0.5 shrink-0 text-emerald-700"/>
                  {hasSkillMatch ? 'Your confirmed profile skills overlap with this role.' : 'This score reflects the platform screening assessment.'}
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-slate-600">{opportunity.requiredSkills.length} listed skills and requirements. Complete your profile to receive a personalized fit assessment.</p>
            )}
          </section>

          <section className="rounded-2xl border border-orange-100 bg-orange-50/70 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <span className="grid size-7 place-items-center rounded-lg bg-white text-orange-700 shadow-sm"><Sparkles size={15}/></span>
              What to strengthen
            </div>
            <div className="mt-3">
              {fitScore !== null ? (
                <p className="text-xs leading-relaxed text-slate-700">
                  {opportunity.firstMissingSkill
                    ? <><span className="font-bold text-orange-900">{opportunity.firstMissingSkill}</span> is listed as a requirement not matched by your current profile.</>
                    : 'Review the full role requirements before applying; no specific skill gap was identified.'}
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-slate-700">Add skills and experience to your profile to unlock role-specific match insights.</p>
              )}
            </div>
          </section>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-100 bg-white px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Why consider this role</p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-600">
            {opportunity.description?.trim() || 'Review the complete job description and eligibility requirements on the employer’s application page.'}
          </p>
        </div>
      </div>

      <footer className="relative flex flex-col gap-2 border-t border-slate-100 bg-slate-50/70 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <Link href={matchHref(opportunity.id)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 text-xs font-bold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50">
          View full analysis <ArrowUpRight size={14}/>
        </Link>
        <a
          href={opportunity.officialUrl || opportunity.sourceUrl || '#'}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { e.stopPropagation(); trackApplyClick(opportunity.id, 'feed_card'); }}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#A94F20] px-7 text-xs font-bold text-white shadow-[0_5px_14px_rgba(169,79,32,0.22)] transition hover:bg-[#873C17] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700"
        >
          Apply now <ArrowUpRight size={15}/>
        </a>
      </footer>
    </article>
  );
}
