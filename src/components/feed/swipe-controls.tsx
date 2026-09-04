'use client';

import React from 'react';
import { X, Heart, RotateCcw, Info } from 'lucide-react';

interface SwipeControlsProps {
  onPass: () => void;
  onInterested: () => void;
  onRewind: () => void;
  onOpenDetails: () => void;
  canRewind: boolean;
  disabled?: boolean;
}

export function SwipeControls({
  onPass,
  onInterested,
  onRewind,
  onOpenDetails,
  canRewind,
  disabled = false,
}: SwipeControlsProps) {
  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-[420px] mt-4">
      {/* Action Buttons */}
      <div className="flex items-center justify-center gap-5 w-full">
        {/* Pass Button */}
        <button
          type="button"
          onClick={onPass}
          disabled={disabled}
          title="Pass (Left Arrow)"
          className="flex h-14 w-14 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-400 shadow-lg shadow-rose-500/5 hover:scale-110 hover:bg-rose-500/20 active:scale-95 transition-all disabled:opacity-40 disabled:hover:scale-100"
        >
          <X className="h-7 w-7" />
        </button>

        {/* Rewind Button */}
        <button
          type="button"
          onClick={onRewind}
          disabled={!canRewind || disabled}
          title="Rewind Last Swipe"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground shadow-md hover:scale-105 hover:text-foreground active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100"
        >
          <RotateCcw className="h-5 w-5" />
        </button>

        {/* Details Button */}
        <button
          type="button"
          onClick={onOpenDetails}
          disabled={disabled}
          title="Full Job Details (Space)"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground shadow-md hover:scale-105 hover:text-foreground active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100"
        >
          <Info className="h-5 w-5" />
        </button>

        {/* Interested Button */}
        <button
          type="button"
          onClick={onInterested}
          disabled={disabled}
          title="Interested (Right Arrow)"
          className="flex h-14 w-14 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shadow-lg shadow-emerald-500/5 hover:scale-110 hover:bg-emerald-500/20 active:scale-95 transition-all disabled:opacity-40 disabled:hover:scale-100"
        >
          <Heart className="h-7 w-7 fill-emerald-400/20" />
        </button>
      </div>

      {/* Keyboard Shortcuts Hint */}
      <div className="hidden sm:flex items-center gap-4 text-[11px] text-muted-foreground select-none">
        <span className="flex items-center gap-1">
          <kbd className="rounded bg-secondary px-1.5 py-0.5 border border-border font-mono text-[10px]">
            ←
          </kbd>
          Pass
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded bg-secondary px-1.5 py-0.5 border border-border font-mono text-[10px]">
            Space
          </kbd>
          Details
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded bg-secondary px-1.5 py-0.5 border border-border font-mono text-[10px]">
            →
          </kbd>
          Interested
        </span>
      </div>
    </div>
  );
}
