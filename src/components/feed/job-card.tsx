'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import Link from 'next/link';
import { Check } from 'lucide-react';

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
  const fitScore = opportunity.fitScore ?? 94;
  const fitLabel =
    opportunity.fitBadge ??
    (fitScore >= 80 ? 'Strong fit' : fitScore >= 65 ? 'Competitive' : 'Moderate fit');

  const metCount = Math.min(
    opportunity.requiredSkills.length,
    Math.max(2, Math.round((fitScore / 100) * opportunity.requiredSkills.length))
  );
  const gapsCount = Math.max(1, opportunity.requiredSkills.length - metCount);

  // Top skills for tags
  const displayTags = opportunity.requiredSkills.slice(0, 3);
  const remainingCount = opportunity.requiredSkills.length - displayTags.length;

  const badgeColor = COMPANY_COLORS[opportunity.company] || 'bg-[var(--ink)] text-white';

  // V1.1: the job card is deliberately kept clean — no Career Transition
  // framing here. Transition analysis (which uses the user's OWN skills, not
  // the job's requirement names) lives only on the Match Detail page. The
  // `opportunity.careerTransition` payload, when present, is consumed only by
  // the Pro-gated feed filter, never rendered on the card.
  return (
    <div className="soft-card relative flex flex-col h-[480px] sm:h-[510px] md:h-[530px] w-full max-w-[440px] md:max-w-[560px] p-5 sm:p-7 select-none justify-between bg-[var(--surface)] text-[var(--ink)] rounded-3xl border border-[var(--line)] shadow-[0_4px_24px_rgba(76,44,30,0.04)] transition-all duration-200">
      {/* Top Details */}
      <div>
        {/* Company & External Link */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`grid size-11 shrink-0 place-items-center rounded-2xl font-bold text-sm shadow-sm ${badgeColor}`}>
              {opportunity.company.charAt(0)}
            </div>
            <div>
              <span className="text-xs font-semibold text-[var(--muted)] tracking-wide">
                {opportunity.company}
              </span>
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--ink)] mt-0.5 leading-snug">
                {opportunity.title}
              </h2>
              <p className="text-xs text-[var(--muted)] mt-1">
                Remote · {opportunity.remoteType === 'Worldwide' ? 'Worldwide' : opportunity.remoteType || 'Eligible'}
              </p>
            </div>
          </div>

          {/* Right Coral-Red Score Box */}
          <div className="rounded-2xl bg-[var(--red-soft)] border border-[var(--red-soft-border)] px-3.5 py-2 text-center shrink-0 min-w-[76px]">
            <div className="mono text-2xl font-bold text-[var(--red)] leading-none">
              {fitScore}%
            </div>
            <div className="text-[10px] font-semibold text-[var(--red)] mt-1 leading-tight uppercase tracking-wider">
              match
            </div>
          </div>
        </div>

        {/* Salary */}
        <p className="text-sm font-semibold text-[var(--ink)] mt-3">
          {opportunity.salaryMin || opportunity.salaryMax
            ? `$${Math.round((opportunity.salaryMin || 0) / 1000)}k – $${Math.round(
                (opportunity.salaryMax || 0) / 1000
              )}k`
            : '$140k – $180k'}
        </p>

        {/* Skills Pills */}
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {displayTags.map((tag) => (
            <span key={tag} className="tag bg-[var(--surface-soft)] border-[var(--line)] text-[#5c5550]">
              {tag}
            </span>
          ))}
          {remainingCount > 0 && (
            <span className="tag bg-[var(--surface-soft)] border-[var(--line)] text-[var(--muted)]">
              +{remainingCount}
            </span>
          )}
        </div>

        {/* Why it matches & What may be missing — standard v1 card view */}
        <div className="mt-4 sm:mt-5 space-y-2 text-xs">
          <div>
            <span className="text-[11px] font-semibold text-[var(--muted)] mb-1 block">
              Why it matches
            </span>
            <div className="flex items-center gap-2 text-[#059669] font-medium bg-[#ecfdf5] border border-[#a7f3d0] px-3.5 py-2 rounded-xl">
              <Check size={14} className="stroke-[3] shrink-0" />
              <span>{metCount} skills match your experience</span>
            </div>
          </div>

          <div>
            <span className="text-[11px] font-semibold text-[var(--muted)] mb-1 block">
              What may be missing
            </span>
            <div className="flex flex-col gap-1 text-[#b45309] font-medium bg-[#fffbeb] border border-[#fde68a] px-3.5 py-2 rounded-xl">
              <div className="flex items-center gap-2">
                <span className="grid size-4 place-items-center rounded-full bg-[#fef3c7] text-[10px] font-bold text-[#b45309] shrink-0">
                  !
                </span>
                <span>
                  {opportunity.requiredSkills.length > metCount
                    ? `The role asks for ${opportunity.requiredSkills[metCount]}.`
                    : 'Check specific domain requirements before applying.'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action Footer: [ See why it matches ]  [ Apply → ] */}
      <div className="pt-3.5 border-t border-[var(--line)] flex items-center justify-between gap-3">
        <Link
          href={`/match/${opportunity.id}`}
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--ink)] flex-1 text-xs font-semibold text-center justify-center py-2.5 transition-colors shadow-sm min-h-[44px] flex items-center"
        >
          See why it matches
        </Link>

        <a
          href={opportunity.officialUrl || opportunity.sourceUrl || '#'}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white flex-1 text-xs font-semibold text-center justify-center flex items-center gap-1.5 py-2.5 transition-colors shadow-sm min-h-[44px]"
        >
          <span>Apply →</span>
        </a>
      </div>
    </div>
  );
}
