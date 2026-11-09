'use client';

import React, { useState, useEffect } from 'react';
import { X, Check, ArrowRight } from 'lucide-react';
import { startProUpgrade, PRO_CURRENCY_PRICES, type ProCurrency } from '@/lib/razorpay-checkout';

export type UpgradeReason =
  | 'rewind'
  | 'swipes'
  | 'rightSwipeLimit'
  | 'totalSwipeLimit'
  | 'proposals'
  | 'filters'
  | 'careerTransition'
  | 'linkedinSearch'
  | 'linkedinPeopleConnect';

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reason?: UpgradeReason;
  onUpgraded?: () => void;
  /**
   * Server-calculated reset timestamp for `rightSwipeLimit` /
   * `totalSwipeLimit` — when that specific cap frees up (the oldest counted
   * swipe aging out of the rolling 24h window). Never computed client-side
   * as "now + 24h"; the two caps can have different reset times.
   */
  resetAt?: string | null;
}

/** "Xh Ym" (or "Ym" under an hour, or "<1m" in the final minute) until `resetAt`. Null once it has passed. */
function formatCountdown(resetAt: string | null | undefined): string | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return minutes <= 0 ? '<1m' : `${minutes}m`;
  return `${hours}h ${minutes}m`;
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
  rightSwipeLimit: {
    title: 'Found enough interesting opportunities?',
    subtitle: "You've used all 15 Interested swipes for today. Upgrade to Pro to access any additional swipe benefits included in your membership.",
    badge: 'Right swipe limit',
  },
  totalSwipeLimit: {
    title: "That's a wrap for today.",
    subtitle: "You've used all 50 daily swipes. Your next discovery session starts when your allowance resets.",
    badge: 'Daily limit reached',
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
  resetAt = null,
}: UpgradeModalProps) {
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [currency, setCurrency] = useState<ProCurrency>('INR');
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeNotice, setUpgradeNotice] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string | null>(() => formatCountdown(resetAt));

  // Recompute every 30s while open — resetAt itself is always server-
  // calculated (never derived as "now + 24h" client-side); this just keeps
  // the displayed string from going stale while the modal is up.
  useEffect(() => {
    setCountdown(formatCountdown(resetAt));
    if (!isOpen || !resetAt) return;
    const id = setInterval(() => setCountdown(formatCountdown(resetAt)), 30_000);
    return () => clearInterval(id);
  }, [isOpen, resetAt]);

  if (!isOpen) return null;

  const copy = REASON_COPY[reason] || REASON_COPY.rewind;
  const showCountdown = (reason === 'rightSwipeLimit' || reason === 'totalSwipeLimit') && countdown;

  const handleUpgrade = async () => {
    // No session-provisioning step needed here — every page that can show
    // this modal is already behind the verified-account gate (middleware +
    // getAuthenticatedUser), so a real session is guaranteed.
    setIsUpgrading(true);
    setUpgradeError(null);
    setUpgradeNotice(null);
    try {
      const result = await startProUpgrade(currency);
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

        {/* Countdown + right-swipe-specific hint — only for the two swipe-limit reasons */}
        {showCountdown && (
          <p className="text-[11px] font-semibold text-[var(--muted)] text-center">
            {reason === 'rightSwipeLimit' ? 'You can still pass on opportunities with your remaining swipes. ' : null}
            Next reset in <span className="text-[var(--ink)]">{countdown}</span>
          </p>
        )}

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

        {/* Explicit currency choice; INR remains the default for existing users. */}
        <div className="space-y-2">
          <label htmlFor="pro-upgrade-currency" className="block text-[11px] font-semibold text-[var(--muted)]">Billing currency</label>
          <select
            id="pro-upgrade-currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value as ProCurrency)}
            disabled={isUpgrading}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] text-xs px-3 py-2.5 min-h-[42px]"
          >
            <option value="INR">INR — ₹499/month</option>
            <option value="USD">USD — $9/month</option>
          </select>
        </div>

        {/* CTA Button */}
        <div className="pt-1">
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={isUpgrading}
            className="w-full soft-button primary text-xs font-semibold py-3.5 min-h-[46px] flex items-center justify-center gap-2 shadow-md"
          >
            <span>{isUpgrading ? 'Connecting to Checkout...' : `Upgrade to Pro — ${PRO_CURRENCY_PRICES[currency]}`}</span>
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
