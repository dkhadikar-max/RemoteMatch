'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import { Globe, DollarSign, Briefcase, Sparkles, CheckCircle2, ChevronRight } from 'lucide-react';

interface JobCardProps {
  opportunity: CanonicalOpportunity;
  onOpenDetails?: () => void;
  isFrontCard?: boolean;
}

export function JobCard({ opportunity, onOpenDetails, isFrontCard = true }: JobCardProps) {
  const fitScore = opportunity.fitScore ?? 84;
  const fitBadge = opportunity.fitBadge ?? (fitScore >= 80 ? 'Strong Fit' : fitScore >= 65 ? 'Good Fit' : 'Moderate Fit');

  const badgeColor =
    fitScore >= 80
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
      : fitScore >= 65
      ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30'
      : 'bg-amber-500/10 text-amber-400 border-amber-500/30';

  return (
    <div className="relative flex flex-col h-[520px] w-full max-w-[420px] rounded-2xl border border-border bg-card p-6 shadow-2xl transition-all select-none overflow-hidden justify-between">
      {/* Background subtle radial glow */}
      <div className="pointer-events-none absolute -top-24 -right-24 h-48 w-48 rounded-full bg-emerald-500/5 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-indigo-500/5 blur-3xl" />

      {/* Header: Company & Fit Score Badge */}
      <div>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            {opportunity.companyLogo ? (
              <img
                src={opportunity.companyLogo}
                alt={opportunity.company}
                className="h-12 w-12 rounded-xl object-cover border border-border bg-secondary"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary border border-border text-foreground font-bold text-lg">
                {opportunity.company.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <h3 className="font-semibold text-base text-foreground line-clamp-1">
                {opportunity.company}
              </h3>
              <span className="text-xs text-muted-foreground capitalize">
                via {opportunity.source}
              </span>
            </div>
          </div>

          {/* Screening FIT SCORE Badge */}
          <div className={`flex flex-col items-end rounded-xl border px-3 py-1.5 ${badgeColor}`}>
            <div className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              <span className="text-xs font-bold uppercase tracking-wider">
                FIT {fitScore}%
              </span>
            </div>
            <span className="text-[10px] font-medium opacity-90">{fitBadge}</span>
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-bold text-foreground leading-snug tracking-tight mb-3">
          {opportunity.title}
        </h2>

        {/* Badges: Location / Salary / Type */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground border border-border">
            <Globe className="h-3 w-3 text-emerald-400" />
            {opportunity.remoteType}
          </span>

          {opportunity.salaryMin || opportunity.salaryMax ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground border border-border">
              <DollarSign className="h-3 w-3 text-indigo-400" />
              {opportunity.salaryMin
                ? `$${Math.round(opportunity.salaryMin / 1000)}k`
                : ''}
              {opportunity.salaryMin && opportunity.salaryMax ? ' - ' : ''}
              {opportunity.salaryMax
                ? `$${Math.round(opportunity.salaryMax / 1000)}k`
                : ''}
            </span>
          ) : null}

          <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground border border-border">
            <Briefcase className="h-3 w-3 text-muted-foreground" />
            {opportunity.employmentType}
          </span>
        </div>

        {/* Key Requirements Section */}
        <div className="space-y-2 mb-4">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Key Requirements
          </span>
          <div className="flex flex-wrap gap-1.5">
            {opportunity.requiredSkills.slice(0, 5).map((skill, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-lg bg-secondary/80 px-2.5 py-1 text-xs font-medium text-foreground border border-border/70"
              >
                <CheckCircle2 className="h-3 w-3 text-primary" />
                {skill}
              </span>
            ))}
          </div>
        </div>

        {/* Brief Excerpt */}
        <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
          {opportunity.description.slice(0, 180)}...
        </p>
      </div>

      {/* Footer / Card Expand Details button */}
      <div className="pt-3 border-t border-border/60 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {isFrontCard ? 'Swipe or tap details' : ''}
        </span>
        {onOpenDetails && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetails();
            }}
            className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-emerald-300 transition-colors"
          >
            <span>View Full Details</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
