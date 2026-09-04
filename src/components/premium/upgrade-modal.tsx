'use client';

import React, { useState } from 'react';
import { X, Check, ArrowRight } from 'lucide-react';
import { ensureAuthenticatedSession } from '@/lib/supabase/browser';

export type UpgradeReason = 'rewind' | 'swipes' | 'proposals' | 'filters';

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
};

const PRO_FEATURES = [
  'Unlimited saves',
  'Unlimited proposal materials',
  'Rewind',
  'Precision location, salary & timezone filters',
];

export function UpgradeModal({
  isOpen,
  onClose,
  reason = 'rewind',
  onUpgraded,
}: UpgradeModalProps) {
  const [isUpgrading, setIsUpgrading] = useState(false);

  if (!isOpen) return null;

  const copy = REASON_COPY[reason] || REASON_COPY.rewind;

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    try {
      await ensureAuthenticatedSession();
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      if (data.url) {
        // If mock session, verify and complete immediately
        if (data.isMock) {
          await fetch('/api/stripe/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'mock_session_success' }),
          });
          if (onUpgraded) {
            onUpgraded();
          }
          onClose();
        } else {
          // Stripe checkout redirect
          window.location.href = data.url;
        }
      }
    } catch (err) {
      console.error('Upgrade failed:', err);
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
        className="relative flex flex-col w-full max-w-md rounded-3xl border border-[#F3E8E2] bg-white p-6 sm:p-7 shadow-[0_20px_50px_rgba(76,44,30,0.12)] animate-modal space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Close */}
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--red)] uppercase tracking-wider bg-[#fdf2f4] border border-[#fcd5dc] px-2.5 py-0.5 rounded-full">
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
            className="grid size-8 place-items-center rounded-xl border border-[#F3E8E2] bg-white text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[#FFF1EA] transition-colors shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Feature List */}
        <div className="rounded-2xl border border-[#F3E8E2] bg-[#FFF7F2] p-4 space-y-2.5">
          <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider block mb-1">
            Everything in RemoteMatch Pro
          </span>
          {PRO_FEATURES.map((feat) => (
            <div key={feat} className="flex items-center gap-2 text-xs font-semibold text-[var(--ink)]">
              <span className="grid size-4 place-items-center rounded-full bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]">
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
            <span>{isUpgrading ? 'Connecting to Checkout...' : 'Upgrade to Pro — $12/month'}</span>
            <ArrowRight size={14} />
          </button>
          <p className="text-[11px] text-[var(--muted)] text-center mt-2">
            Cancel anytime. Immediate access upon upgrade.
          </p>
        </div>
      </div>
    </div>
  );
}
