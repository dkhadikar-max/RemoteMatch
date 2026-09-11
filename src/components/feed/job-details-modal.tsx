'use client';

import React from 'react';
import { CanonicalOpportunity } from '@/types/byn';
import { formatPostedAge, formatSalary } from '@/lib/feed/job-card-format';
import {
  sourceDisplayName,
  remoteScopeCaveat,
  salaryQualifierLabel,
  linkVerifiedLabel,
  employerDirectApplyLabel,
} from '@/lib/feed/trust-signals';
import { X, Globe2, DollarSign, Briefcase, Check, ExternalLink, ShieldCheck } from 'lucide-react';

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
            {/* No logos (H): a colored initial only — never a third-party or
                unverified image asserted as an employer's logo. */}
            <div className="grid size-12 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--ink)] font-bold text-sm">
              {opportunity.company.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-[var(--ink)] tracking-tight">
                {opportunity.title}
              </h2>
              <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-[var(--muted)]">
                <span className="font-semibold text-[var(--ink)]">{opportunity.company}</span>
                <span>·</span>
                <span>{opportunity.remoteType}</span>
                {formatPostedAge(opportunity.postedAt) && (
                  <>
                    <span>·</span>
                    <span>{formatPostedAge(opportunity.postedAt)}</span>
                  </>
                )}
                {/* M1 — the one genuinely real freshness fact beyond posting
                    age: when we last confirmed the link itself. Additive —
                    never replaces postedAge, never shown when absent. */}
                {linkVerifiedLabel(opportunity.linkCheckedAt) && (
                  <>
                    <span>·</span>
                    <span>{linkVerifiedLabel(opportunity.linkCheckedAt)}</span>
                  </>
                )}
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
              {/* M4 — explicitRemoteScope is a separate, honest signal from
                  remoteType (which defaults unmatched input to 'Worldwide'
                  for matching purposes). Never phrased as a negative claim. */}
              <p className="text-[10px] text-[var(--muted)] mt-1 leading-snug">
                {remoteScopeCaveat(opportunity.explicitRemoteScope)}
              </p>
            </div>

            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] rounded-xl">
              <span className="eyebrow block">Compensation</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <DollarSign size={13} className="text-[var(--red)]" />
                <span className="mono">{formatSalary(opportunity)}</span>
                {/* M3 — only ever attached when a real salary IS shown;
                    "Salary not listed" never gets a qualifier. */}
                {salaryQualifierLabel(opportunity) && (
                  <span className="text-[10px] font-semibold text-[var(--muted)] normal-case bg-[var(--surface-soft)] border border-[var(--line)] rounded-full px-1.5 py-0.5">
                    {salaryQualifierLabel(opportunity)}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] rounded-xl">
              <span className="eyebrow block">Role Type</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <Briefcase size={13} className="text-[var(--muted)]" />
                <span>{opportunity.employmentType}</span>
              </div>
            </div>

            {/* M2 — provenance label only, never the underlying editorial
                sourceQuality number (would imply unsupported precision). */}
            <div className="p-3.5 border border-[var(--line)] bg-[var(--bg)] rounded-xl">
              <span className="eyebrow block">Source</span>
              <div className="flex items-center gap-1.5 mt-1.5 font-semibold text-xs text-[var(--ink)]">
                <ShieldCheck size={13} className="text-[var(--muted)]" />
                <span>{sourceDisplayName(opportunity.source)}</span>
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

          {/* M9/M10.1 — only asserted where the data actually establishes it
              (see employerDirectApplyLabel's own doc comment). Silent, not a
              negative claim, for every other source today. */}
          {employerDirectApplyLabel(opportunity.source) && (
            <p className="text-[11px] text-[var(--muted)] flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-[#059669]" />
              {employerDirectApplyLabel(opportunity.source)}
            </p>
          )}
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
