'use client';

import React from 'react';
import Link from 'next/link';
import { RotateCcw, Inbox, CheckCircle2, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import { FEED_EMPTY_COPY, type FeedEmptyKind } from '@/lib/feed/empty-state';

/**
 * Shown INSTEAD of the swipe deck when there is nothing to swipe, with a message that matches the real reason
 * (see src/lib/feed/empty-state.ts). Only `all_reviewed` ever says the user has gone through everything.
 */
interface FeedEmptyStateProps {
  kind: FeedEmptyKind;
  onRetry: () => void;
  onClearFilters: () => void;
}

const ICON: Record<FeedEmptyKind, React.ReactNode> = {
  load_failed: <AlertTriangle size={24} aria-hidden="true" />,
  no_supply: <Inbox size={24} aria-hidden="true" />,
  all_reviewed: <CheckCircle2 size={24} aria-hidden="true" />,
  filters_exclude_all: <SlidersHorizontal size={24} aria-hidden="true" />,
};

export function FeedEmptyState({ kind, onRetry, onClearFilters }: FeedEmptyStateProps) {
  const copy = FEED_EMPTY_COPY[kind];
  const isError = kind === 'load_failed';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className="soft-card flex flex-col items-center justify-center w-full max-w-[440px] md:max-w-[560px] min-h-[320px] p-8 text-center space-y-4 rounded-3xl border border-[var(--line)]"
    >
      <div className="grid size-12 place-items-center rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] text-[var(--ink)]">{ICON[kind]}</div>
      <h2 className="text-xl font-bold text-[var(--ink)]">{copy.title}</h2>
      <p className="text-sm text-[var(--muted)] leading-relaxed max-w-sm">{copy.body}</p>
      <div className="flex flex-col sm:flex-row gap-3 w-full justify-center pt-2">
        {kind === 'load_failed' && (
          <button type="button" onClick={onRetry} className="soft-button primary flex items-center justify-center gap-2 text-xs min-h-[44px]">
            <RotateCcw size={14} aria-hidden="true" />
            <span>Try again</span>
          </button>
        )}
        {kind === 'filters_exclude_all' && (
          <button type="button" onClick={onClearFilters} className="soft-button primary flex items-center justify-center text-xs min-h-[44px]">
            Clear filters
          </button>
        )}
        {(kind === 'no_supply' || kind === 'all_reviewed') && (
          <button type="button" onClick={onRetry} className="soft-button secondary flex items-center justify-center gap-2 text-xs min-h-[44px]">
            <RotateCcw size={14} aria-hidden="true" />
            <span>Check again</span>
          </button>
        )}
        {kind !== 'load_failed' && kind !== 'filters_exclude_all' && (
          <Link href="/tracker" className="soft-button secondary flex items-center justify-center text-xs min-h-[44px]">
            View your applications
          </Link>
        )}
      </div>
    </div>
  );
}
