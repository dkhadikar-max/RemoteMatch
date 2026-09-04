'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import { X, Globe, DollarSign, Briefcase, CheckCircle2, Heart, ExternalLink } from 'lucide-react';

interface JobDetailsModalProps {
  opportunity: CanonicalOpportunity | null;
  isOpen: boolean;
  onClose: () => void;
  onPass: () => void;
  onInterested: () => void;
}

export function JobDetailsModal({
  opportunity,
  isOpen,
  onClose,
  onPass,
  onInterested,
}: JobDetailsModalProps) {
  if (!isOpen || !opportunity) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="relative flex flex-col w-full max-w-2xl max-h-[88vh] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-border bg-secondary/30">
          <div className="flex items-center gap-3">
            {opportunity.companyLogo ? (
              <img
                src={opportunity.companyLogo}
                alt={opportunity.company}
                className="h-14 w-14 rounded-xl object-cover border border-border bg-secondary"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-secondary border border-border text-foreground font-bold text-xl">
                {opportunity.company.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <h2 className="text-xl font-bold text-foreground">
                {opportunity.title}
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm font-medium text-muted-foreground">
                  {opportunity.company}
                </span>
                <span className="text-xs text-muted-foreground/60">•</span>
                <span className="text-xs text-indigo-400 capitalize">
                  {opportunity.source}
                </span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-secondary/50 border border-border">
              <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                Remote Scope
              </span>
              <div className="flex items-center gap-1.5 mt-1 font-medium text-sm text-foreground">
                <Globe className="h-4 w-4 text-emerald-400" />
                <span>{opportunity.remoteType}</span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-secondary/50 border border-border">
              <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                Compensation
              </span>
              <div className="flex items-center gap-1.5 mt-1 font-medium text-sm text-foreground">
                <DollarSign className="h-4 w-4 text-indigo-400" />
                <span>
                  {opportunity.salaryMin || opportunity.salaryMax
                    ? `$${Math.round((opportunity.salaryMin || 0) / 1000)}k - $${Math.round(
                        (opportunity.salaryMax || 0) / 1000
                      )}k`
                    : 'Competitive'}
                </span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-secondary/50 border border-border">
              <span className="text-[11px] text-muted-foreground uppercase font-semibold">
                Role Type
              </span>
              <div className="flex items-center gap-1.5 mt-1 font-medium text-sm text-foreground">
                <Briefcase className="h-4 w-4 text-amber-400" />
                <span>{opportunity.employmentType}</span>
              </div>
            </div>
          </div>

          {/* Required Skills */}
          {opportunity.requiredSkills.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Required Capabilities
              </h4>
              <div className="flex flex-wrap gap-2">
                {opportunity.requiredSkills.map((skill, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-foreground border border-border"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Full Description */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Opportunity Overview
            </h4>
            <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line space-y-2">
              {opportunity.description}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between p-4 px-6 border-t border-border bg-secondary/20">
          <button
            type="button"
            onClick={() => {
              onClose();
              onPass();
            }}
            className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-2.5 text-sm font-semibold text-rose-400 hover:bg-rose-500/20 transition-all"
          >
            <X className="h-4 w-4" />
            <span>Pass Opportunity</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onClose();
              onInterested();
            }}
            className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-all"
          >
            <Heart className="h-4 w-4 fill-white" />
            <span>Mark Interested & Analyze</span>
          </button>
        </div>
      </div>
    </div>
  );
}
