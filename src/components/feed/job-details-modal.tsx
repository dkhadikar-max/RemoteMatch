'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import { X, Globe2, DollarSign, Briefcase, Check, ExternalLink } from 'lucide-react';

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/30 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-2xl max-h-[88vh] rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-xl overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 sm:p-7 border-b border-[var(--line)] bg-[var(--surface)]">
          <div className="flex items-center gap-4">
            {opportunity.companyLogo ? (
              <img
                src={opportunity.companyLogo}
                alt={opportunity.company}
                className="size-12 rounded-2xl object-cover border border-[var(--line)] bg-[var(--surface-soft)]"
              />
            ) : (
              <div className="grid size-12 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--ink)] font-bold text-sm">
                {opportunity.company.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <h2 className="text-xl font-semibold text-[var(--ink)] tracking-tight">
                {opportunity.title}
              </h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-[var(--muted)]">
                <span className="font-semibold text-[var(--ink)]">{opportunity.company}</span>
                <span>·</span>
                <span>{opportunity.remoteType}</span>
                <span>·</span>
                <span className="capitalize">{opportunity.source}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content Body (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-7 space-y-6">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] rounded-xl">
              <span className="eyebrow block">Remote Scope</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <Globe2 size={13} className="text-[var(--red)]" />
                <span>{opportunity.remoteType}</span>
              </div>
            </div>

            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] rounded-xl">
              <span className="eyebrow block">Compensation</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <DollarSign size={13} className="text-[var(--red)]" />
                <span className="mono">
                  {opportunity.salaryMin || opportunity.salaryMax
                    ? `$${Math.round((opportunity.salaryMin || 0) / 1000)}k – $${Math.round(
                        (opportunity.salaryMax || 0) / 1000
                      )}k`
                    : 'Benchmark verified'}
                </span>
              </div>
            </div>

            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] col-span-2 sm:col-span-1 rounded-xl">
              <span className="eyebrow block">Role Type</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <Briefcase size={13} className="text-[var(--muted)]" />
                <span>{opportunity.employmentType}</span>
              </div>
            </div>
          </div>

          {/* Required Skills */}
          {opportunity.requiredSkills && opportunity.requiredSkills.length > 0 && (
            <div>
              <h3 className="eyebrow mb-3">Core Requirements</h3>
              <div className="flex flex-wrap gap-2">
                {opportunity.requiredSkills.map((skill, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-2.5 py-1 text-xs text-[var(--ink)] font-medium"
                  >
                    <Check size={12} className="text-[#059669]" />
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <h3 className="eyebrow mb-3">Role Scope & Context</h3>
            <div className="text-xs leading-relaxed text-[var(--ink)]/80 whitespace-pre-line space-y-2 p-4 border border-[var(--line)] bg-[var(--bg)]/50">
              {opportunity.description}
            </div>
          </div>
        </div>

        {/* Modal Actions Footer */}
        <div className="flex items-center justify-between p-5 sm:p-6 border-t border-[var(--line)] bg-[var(--surface)]">
          <button
            onClick={() => {
              onPass();
              onClose();
            }}
            className="soft-button secondary text-xs font-semibold py-2 px-4 text-[var(--muted)] hover:text-[var(--ink)]"
          >
            Pass
          </button>

          <div className="flex items-center gap-2">
            <a
              href={opportunity.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="soft-button secondary text-xs font-semibold gap-1.5 py-2 px-4"
            >
              <span>Official Listing</span>
              <ExternalLink size={13} className="text-[var(--muted)]" />
            </a>

            <button
              onClick={() => {
                onInterested();
                onClose();
              }}
              className="soft-button primary text-xs font-semibold py-2 px-5"
            >
              Inspect Match & Decide
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
