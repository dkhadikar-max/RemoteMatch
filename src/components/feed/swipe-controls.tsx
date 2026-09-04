'use client';

import React from 'react';
import { X, Check, RotateCcw, FileText } from 'lucide-react';

interface SwipeControlsProps {
  onPass: () => void;
  onInterested: () => void;
  onRewind: () => void;
  onOpenDetails: () => void;
  canRewind: boolean;
  disabled?: boolean;
  planTier?: 'free' | 'pro';
  onRequireUpgrade?: (reason: 'rewind') => void;
}

export function SwipeControls({
  onPass,
  onInterested,
  onRewind,
  onOpenDetails,
  canRewind,
  disabled = false,
  planTier = 'free',
  onRequireUpgrade,
}: SwipeControlsProps) {
  const isFree = planTier === 'free';

  const handleRewindClick = () => {
    if (isFree) {
      onRequireUpgrade?.('rewind');
      return;
    }
    if (canRewind && !disabled) {
      onRewind();
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-[440px] md:max-w-[560px] mt-4">
      {/* Soft Action Controls (Minimum 44px+ touch targets) */}
      <div className="flex items-center justify-between w-full gap-2.5">
        <button
          type="button"
          onClick={onPass}
          disabled={disabled}
          title="Pass (Left Arrow)"
          className="flex-1 min-h-[48px] rounded-2xl border border-[#F3E8E2] bg-white hover:bg-[#FFF1EA] text-[var(--muted)] hover:text-[var(--ink)] py-2.5 px-4 text-xs font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-30 active:scale-[0.98]"
        >
          <X size={17} className="text-[var(--muted)]" />
          <span>Pass</span>
        </button>

        <button
          type="button"
          onClick={handleRewindClick}
          disabled={(!isFree && !canRewind) || disabled}
          title={isFree ? 'Rewind (Pro feature)' : 'Rewind Last Swipe'}
          className="relative size-12 place-items-center rounded-2xl border border-[#F3E8E2] bg-white hover:bg-[#FFF1EA] text-[var(--muted)] hover:text-[var(--ink)] transition-colors shadow-sm disabled:opacity-30 shrink-0 flex items-center justify-center active:scale-[0.98]"
        >
          <RotateCcw size={17} />
          {isFree && (
            <span className="absolute -top-1 -right-1 text-[8px] font-bold bg-[#fdf2f4] text-[var(--red)] border border-[#fcd5dc] px-1 rounded-full leading-tight">
              PRO
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onOpenDetails}
          disabled={disabled}
          title="Job Details (Space)"
          className="size-12 place-items-center rounded-2xl border border-[#F3E8E2] bg-white hover:bg-[#FFF1EA] text-[var(--muted)] hover:text-[var(--ink)] transition-colors shadow-sm disabled:opacity-30 shrink-0 flex items-center justify-center active:scale-[0.98]"
        >
          <FileText size={17} />
        </button>

        <button
          type="button"
          onClick={onInterested}
          disabled={disabled}
          title="Save & Interested (Right Arrow)"
          className="flex-1 min-h-[48px] rounded-2xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white py-2.5 px-4 text-xs font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-40 active:scale-[0.98]"
        >
          <Check size={17} strokeWidth={2.5} />
          <span>Interested</span>
        </button>
      </div>

      {/* Keyboard Shortcuts Hint */}
      <div className="hidden sm:flex items-center gap-3 text-xs text-[var(--muted)] select-none">
        <span>← Pass</span>
        <span className="text-[var(--muted)]/40">·</span>
        <span>Space Details</span>
        <span className="text-[var(--muted)]/40">·</span>
        <span>→ Interested</span>
      </div>
    </div>
  );
}
