'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { motion, useMotionValue, useTransform, AnimatePresence } from 'framer-motion';
import { CanonicalOpportunity } from '@/types/byn';
import { JobCard } from './job-card';
import { SwipeControls } from './swipe-controls';
import { JobDetailsModal } from './job-details-modal';
import { CheckCircle2, Check, X, RotateCcw, ArrowRight } from 'lucide-react';
import Link from 'next/link';

interface SwipeDeckProps {
  opportunities: CanonicalOpportunity[];
  onSwipe: (opportunityId: string, action: 'interested' | 'passed') => void;
  onRewind: () => Promise<string | null>;
  canRewind: boolean;
  planTier?: 'free' | 'pro';
  dailyRightSwipesCount?: number;
  onRequireUpgrade?: (reason: 'rewind' | 'swipes') => void;
}

export function SwipeDeck({
  opportunities,
  onSwipe,
  onRewind,
  canRewind,
  planTier = 'free',
  dailyRightSwipesCount = 0,
  onRequireUpgrade,
}: SwipeDeckProps) {
  const [deck, setDeck] = useState<CanonicalOpportunity[]>(opportunities);
  const [selectedOpp, setSelectedOpp] = useState<CanonicalOpportunity | null>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [lastInterestedOpp, setLastInterestedOpp] = useState<CanonicalOpportunity | null>(null);
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    setDeck(opportunities);
  }, [opportunities]);

  const currentOpp = deck[0];
  const nextOpp = deck[1];

  // Motion values for front card drag & tilt
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-18, 18]);
  const interestedOpacity = useTransform(x, [40, 120], [0, 1]);
  const passOpacity = useTransform(x, [-40, -120], [0, 1]);

  const handleSwipe = useCallback(
    (action: 'interested' | 'passed') => {
      if (!currentOpp) return;
      const swiped = currentOpp;

      if (action === 'interested') {
        if (planTier === 'free' && dailyRightSwipesCount >= 15) {
          x.set(0);
          onRequireUpgrade?.('swipes');
          return;
        }
        setLastInterestedOpp(swiped);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 6000);
      }

      onSwipe(swiped.id, action);
      setDeck((prev) => prev.slice(1));
      x.set(0);
    },
    [currentOpp, onSwipe, x, planTier, dailyRightSwipesCount, onRequireUpgrade]
  );

  const handleRewind = useCallback(async () => {
    if (planTier === 'free') {
      onRequireUpgrade?.('rewind');
      return;
    }
    const rewoundId = await onRewind();
    if (rewoundId) {
      const rewoundOpp = opportunities.find((o) => o.id === rewoundId);
      if (rewoundOpp) {
        setDeck((prev) => [rewoundOpp, ...prev.filter((o) => o.id !== rewoundId)]);
      }
    }
  }, [onRewind, opportunities, planTier, onRequireUpgrade]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDetailsOpen) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSwipe('passed');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSwipe('interested');
      } else if (e.key === ' ' && currentOpp) {
        e.preventDefault();
        setSelectedOpp(currentOpp);
        setIsDetailsOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSwipe, currentOpp, isDetailsOpen]);

  if (!currentOpp) {
    return (
      <div className="soft-card flex flex-col items-center justify-center h-[480px] sm:h-[510px] md:h-[530px] w-full max-w-[440px] md:max-w-[560px] p-8 text-center space-y-4 rounded-3xl border border-[var(--line)]">
        <div className="grid size-12 place-items-center rounded-2xl bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]">
          <CheckCircle2 size={24} />
        </div>
        <h3 className="text-xl font-bold text-[var(--ink)]">
          Queue Cleared
        </h3>
        <p className="text-xs text-[var(--muted)] leading-relaxed max-w-sm">
          All opportunities matching your criteria have been evaluated. Review your saved matches in the outcome tracker or adjust your filters.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 w-full pt-2">
          {canRewind && (
            <button
              onClick={handleRewind}
              className="soft-button secondary flex-1 flex items-center justify-center gap-2 text-xs border-[var(--line)]"
            >
              <RotateCcw size={14} />
              <span>Rewind</span>
            </button>
          )}
          <Link
            href="/tracker"
            className="soft-button primary flex-1 flex items-center justify-center gap-2 text-xs"
          >
            <span>Outcome Tracker</span>
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center justify-center w-full max-w-[440px] md:max-w-[560px]">
      {/* Toast Notification upon Right-Swipe */}
      <AnimatePresence>
        {showToast && lastInterestedOpp && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute -top-16 z-50 flex items-center justify-between gap-3 w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 shadow-[0_4px_20px_rgba(76,44,30,0.06)] text-xs"
          >
            <div className="flex items-center gap-2 text-[var(--ink)]">
              <Check size={15} className="text-[#059669]" />
              <span className="font-semibold line-clamp-1">
                Saved & Analyzed: {lastInterestedOpp.company}
              </span>
            </div>
            <Link
              href={`/match/${lastInterestedOpp.id}`}
              className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white font-semibold px-3 py-1.5 text-xs transition-colors shrink-0 flex items-center gap-1 min-h-[36px]"
            >
              <span>View Match</span>
              <ArrowRight size={12} />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card Stack Area */}
      <div className="relative h-[480px] sm:h-[510px] md:h-[530px] w-full flex items-center justify-center">
        {/* Background Card Peek */}
        {nextOpp && (
          <div className="absolute top-2.5 scale-[0.97] opacity-60 pointer-events-none w-full max-w-[440px] md:max-w-[560px]">
            <JobCard opportunity={nextOpp} isFrontCard={false} />
          </div>
        )}

        {/* Draggable Front Card */}
        <motion.div
          key={currentOpp.id}
          style={{ x, rotate }}
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.8}
          onDragEnd={(_, info) => {
            if (info.offset.x > 110) {
              handleSwipe('interested');
            } else if (info.offset.x < -110) {
              handleSwipe('passed');
            }
          }}
          className="absolute cursor-grab active:cursor-grabbing w-full max-w-[440px] md:max-w-[560px] touch-none"
        >
          {/* Visual Stamp: INTERESTED */}
          <motion.div
            style={{ opacity: interestedOpacity }}
            className="pointer-events-none absolute top-8 left-8 z-30 flex items-center gap-1.5 rounded-2xl border-2 border-[#059669] bg-[#ecfdf5] px-4 py-2 text-sm font-bold tracking-wider text-[#059669] -rotate-12 shadow-md"
          >
            <Check className="size-5 stroke-[3]" />
            <span>INTERESTED</span>
          </motion.div>

          {/* Visual Stamp: PASS */}
          <motion.div
            style={{ opacity: passOpacity }}
            className="pointer-events-none absolute top-8 right-8 z-30 flex items-center gap-1.5 rounded-2xl border-2 border-[var(--danger)] bg-[#fdf2f2] px-4 py-2 text-sm font-bold tracking-wider text-[var(--danger)] rotate-12 shadow-md"
          >
            <X className="size-5 stroke-[3]" />
            <span>PASS</span>
          </motion.div>

          <JobCard
            opportunity={currentOpp}
            onOpenDetails={() => {
              setSelectedOpp(currentOpp);
              setIsDetailsOpen(true);
            }}
          />
        </motion.div>
      </div>

      {/* Swipe Control Buttons */}
      <SwipeControls
        onPass={() => handleSwipe('passed')}
        onInterested={() => handleSwipe('interested')}
        onRewind={handleRewind}
        onOpenDetails={() => {
          setSelectedOpp(currentOpp);
          setIsDetailsOpen(true);
        }}
        canRewind={canRewind}
        planTier={planTier}
        onRequireUpgrade={onRequireUpgrade}
      />

      {/* Full Details Modal */}
      <JobDetailsModal
        opportunity={selectedOpp}
        isOpen={isDetailsOpen}
        onClose={() => setIsDetailsOpen(false)}
        onPass={() => {
          setIsDetailsOpen(false);
          handleSwipe('passed');
        }}
        onInterested={() => {
          setIsDetailsOpen(false);
          handleSwipe('interested');
        }}
      />
    </div>
  );
}
