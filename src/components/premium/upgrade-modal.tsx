'use client';

import React, { useState } from 'react';
import { X, Check, ArrowRight } from 'lucide-react';
import { startProUpgrade } from '@/lib/razorpay-checkout';

export type UpgradeReason = 'rewind' | 'swipes' | 'proposals' | 'filters' | 'careerTransition' | 'linkedinSearch' | 'linkedinPeopleConnect';

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reason?: UpgradeReason;
  onUpgraded?: () => void;
}

const REASON_COPY: Record<
  UpgradeReason,
  { title: string; subtitle: string; badge: string }
> = {
  rewind: {
    title: 'Go back to that job.',
    subtitle: 'Rewind accidental passes with RemoteMatch Pro.',
    badge: 'Rewind',
  },
  swipes: {
    title: "You've used your 15 saves today.",
    subtitle: 'Upgrade to Pro for unlimited saves.',
    badge: '15 saves reached',
  },
  proposals: {
    title: "You've used your 5 proposal generations today.",
    subtitle: 'Upgrade for unlimited proposal materials.',
    badge: 'Proposal limit',
  },
  filters: {
    title: 'Precision targeting is a Pro feature',
    subtitle: 'Filter by specific location, minimum salary, and strict timezone requirements.',
    badge: 'Advanced filters',
  },
  careerTransition: {
    title: 'Find roles for your career transition',
    subtitle:
      'Your transition analysis is free. Upgrade to Pro to discover and filter the jobs that match your transition.',
    badge: 'Career transition',
  },
  linkedinSearch: {
    title: "You've used your free LinkedIn searches today.",
    subtitle: 'Upgrade to Pro for unlimited automated LinkedIn job search.',
    badge: 'LinkedIn search limit',
  },
  linkedinPeopleConnect: {
    title: 'Connect with people at the company',
    subtitle:
      'Your LinkedIn job match analysis is free. Upgrade to Pro for AI-drafted connection messages and company people-search.',
    badge: 'LinkedIn Job Finder',
  },
};

const PRO_FEATURES = [
  'Unlimited saves',
  'Unlimited proposal materials',
  'Rewind',
  'Precision location, salary & timezone filters',
  'Career transition job discovery',
  'Unlimited LinkedIn job search',
  'LinkedIn connection-message drafts & people search',
];

export function UpgradeModal({
  isOpen,
  onClose,
  reason = 'rewind',
  onUpgraded,
}: UpgradeModalProps) {
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const copy = REASON_COPY[reason] || REASON_COPY.rewind;

  const handleUpgrade = async () => {
    // No session-provisioning step needed here — every page that can show
    // this modal is already behind the verified-account gate (middleware +
    // getAuthenticatedUser), so a real session is guaranteed.
    setIsUpgrading(true);
    setUpgradeError(null);
    setUpgradeNotice(null);
    try {
      const result = await startProUpgrade();
      if (result.status === 'upgraded') {
        onUpgraded?.();
        onClose();
      } else if (result.status === 'confirming') {
        setUpgradeNotice(result.message);
      } else if (result.status === 'error') {
        setUpgradeError(result.message);
      }
    } finally {
      setIsUpgrading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-md rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 sm:p-7 shadow-[0_20px_50px_rgba(76,44,30,0.12)] animate-modal space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Close */}
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--red)] uppercase tracking-wider bg-[var(--red-soft)] border border-[var(--red-soft-border)] px-2.5 py-0.5 rounded-full">
              {copy.badge}
            </span>
            <h3 className="text-xl font-bold text-[var(--ink)] pt-1 leading-snug">
              {copy.title}
            </h3>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              {copy.subtitle}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Feature List */}
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg)] p-4 space-y-2.5">
          <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider block mb-1">
            Everything in RemoteMatch Pro
          </span>
          {PRO_FEATURES.map((feat) => (
            <div key={feat} className="flex items-center gap-2 text-xs font-semibold text-[var(--ink)]">
              <span className="grid size-4 place-items-center rounded-full bg-[#ecfdf5] text-[#04714f] border border-[#a7f3d0]">
                <Check size={11} strokeWidth={3} />
              </span>
              <span>{feat}</span>
            </div>
          ))}
        </div>

        {/* CTA Button */}
        <div className="pt-1">
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={isUpgrading}
            className="w-full soft-button primary text-xs font-semibold py-3.5 min-h-[46px] flex items-center justify-center gap-2 shadow-md"
          >
            <span>{isUpgrading ? 'Connecting to Checkout...' : 'Upgrade to Pro — ₹499/month'}</span>
            <ArrowRight size={14} />
          </button>
          {upgradeError && (
            <p className="text-[11px] font-medium text-[var(--red)] text-center mt-2">{upgradeError}</p>
          )}
          {upgradeNotice && (
            <p role="status" className="text-[11px] font-medium text-[var(--ink)] text-center mt-2">{upgradeNotice}</p>
          )}
          <p className="text-[11px] text-[var(--muted)] text-center mt-2">
            Cancel anytime. Immediate access upon upgrade.
          </p>
        </div>
      </div>
    </div>
  );
}
