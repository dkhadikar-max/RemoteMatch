'use client';

import React, { useState } from 'react';
import { ExternalLink, Users, MessageSquareText, Loader2 } from 'lucide-react';
import type { MatchAnalysisResult } from '@/types/byn';
import type { DescriptionConfidence, LinkedInJobProvenance } from '@/types/linkedin-jobs';
import {
  linkedInBadgeLabel,
  provenanceBadgeLabel,
  confidenceLabel,
} from '@/lib/linkedin-jobs/trust-signals';
import { buildLinkedInPeopleSearchUrl, suggestPeopleSearchRoleKeywords } from '@/lib/linkedin-jobs/deep-links';

/**
 * LinkedIn Job Finder — result/analysis card (plan §26). Visually modeled
 * on match-analysis-view.tsx's layout conventions but NOT that component
 * reused unmodified — omits every catalog-only affordance (freshness
 * badges, source-verified salary quality) and adds the plan §25
 * attribution/confidence block, which a catalog card never needs.
 */
export interface LinkedInMatchViewProps {
  title: string;
  company: string;
  location?: string;
  linkedinUrl: string;
  provenance: LinkedInJobProvenance;
  descriptionConfidence: DescriptionConfidence;
  match: MatchAnalysisResult;
  isPro: boolean;
  onRequireUpgrade: (reason: 'linkedinPeopleConnect') => void;
  /** Called only when isPro — fetches a connection-message draft for THIS
   *  job. Kept as a prop (not fetched internally) so the page owns the
   *  single source of truth for the job's fields the API needs. */
  onGenerateConnectionMessage: () => Promise<string>;
}

export function LinkedInMatchView({
  title,
  company,
  location,
  linkedinUrl,
  provenance,
  descriptionConfidence,
  match,
  isPro,
  onRequireUpgrade,
  onGenerateConnectionMessage,
}: LinkedInMatchViewProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showPeople, setShowPeople] = useState(false);

  const confidence = confidenceLabel(descriptionConfidence);
  const roleKeywords = suggestPeopleSearchRoleKeywords(title);

  const handleDraftClick = async () => {
    if (!isPro) {
      onRequireUpgrade('linkedinPeopleConnect');
      return;
    }
    setIsGenerating(true);
    try {
      const message = await onGenerateConnectionMessage();
      setDraft(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePeopleClick = () => {
    if (!isPro) {
      onRequireUpgrade('linkedinPeopleConnect');
      return;
    }
    setShowPeople((v) => !v);
  };

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 space-y-4 shadow-sm">
      {/* Attribution block — plan §25, always present, never dismissible */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0a66c2] uppercase tracking-wider bg-[#e8f2fc] border border-[#c7e0f4] px-2.5 py-0.5 rounded-full">
          {linkedInBadgeLabel()}
        </span>
        <span className="inline-flex items-center text-[11px] font-semibold text-[var(--muted)] bg-[var(--bg)] border border-[var(--line)] px-2.5 py-0.5 rounded-full">
          {provenanceBadgeLabel(provenance)}
        </span>
        <span className="ml-auto text-[11px] font-bold text-[var(--red)] bg-[var(--red-soft)] border border-[var(--red-soft-border)] px-2.5 py-0.5 rounded-full">
          {match.fitBadge}
        </span>
      </div>

      <div>
        <h3 className="text-base font-bold text-[var(--ink)] leading-snug">{title}</h3>
        <p className="text-sm text-[var(--muted)]">
          {company}
          {location ? ` · ${location}` : ''}
        </p>
      </div>

      {confidence && (
        <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {confidence}
        </p>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-bold text-[var(--muted)] uppercase tracking-wider">Why this matches</p>
        <p className="text-sm text-[var(--ink)] leading-relaxed">{match.whyThisJob}</p>
      </div>

      {match.strengths.length > 0 && (
        <div className="space-y-1">
          {match.strengths.slice(0, 3).map((s, i) => (
            <div key={i} className="text-xs text-[var(--ink)]">• {s}</div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <a
          href={linkedinUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
        >
          Open on LinkedIn <ExternalLink size={13} />
        </a>

        <button
          type="button"
          onClick={handlePeopleClick}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
        >
          <Users size={13} /> Find people at {company}
        </button>

        <button
          type="button"
          onClick={handleDraftClick}
          disabled={isGenerating}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors disabled:opacity-60"
        >
          {isGenerating ? <Loader2 size={13} className="animate-spin" /> : <MessageSquareText size={13} />}
          Draft a connection message
        </button>
      </div>

      {showPeople && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3 space-y-2">
          <p className="text-[11px] font-semibold text-[var(--muted)]">
            Suggested roles to search for on LinkedIn:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {roleKeywords.map((kw) => (
              <a
                key={kw}
                href={buildLinkedInPeopleSearchUrl(company, kw)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-semibold text-[#0a66c2] bg-[#e8f2fc] border border-[#c7e0f4] rounded-full px-2.5 py-1 hover:bg-[#d5eafc] transition-colors"
              >
                {kw} →
              </a>
            ))}
          </div>
        </div>
      )}

      {draft && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-[var(--muted)]">
            Draft — personalize once you&apos;ve picked someone on LinkedIn, then send it yourself:
          </p>
          <p className="text-sm text-[var(--ink)] leading-relaxed">{draft}</p>
        </div>
      )}
    </div>
  );
}
