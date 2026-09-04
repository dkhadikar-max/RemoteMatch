'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { motion, useMotionValue, useTransform, AnimatePresence } from 'framer-motion';
import { CanonicalOpportunity } from '@/types/byn';
import { JobCard } from './job-card';
import { SwipeControls } from './swipe-controls';
import { JobDetailsModal } from './job-details-modal';
import { Sparkles, Check, X, RotateCcw, ArrowRight } from 'lucide-react';
import Link from 'next/link';

interface SwipeDeckProps {
  opportunities: CanonicalOpportunity[];
  onSwipe: (opportunityId: string, action: 'interested' | 'passed') => void;
  onRewind: () => Promise<string | null>;
  canRewind: boolean;
}

export function SwipeDeck({
  opportunities,
  onSwipe,
  onRewind,
  canRewind,
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
        setLastInterestedOpp(swiped);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 6000);
      }

      onSwipe(swiped.id, action);
      setDeck((prev) => prev.slice(1));
      x.set(0);
    },
    [currentOpp, onSwipe, x]
  );

  const handleRewind = useCallback(async () => {
    const rewoundId = await onRewind();
    if (rewoundId) {
      const rewoundOpp = opportunities.find((o) => o.id === rewoundId);
      if (rewoundOpp) {
        setDeck((prev) => [rewoundOpp, ...prev.filter((o) => o.id !== rewoundId)]);
      }
    }
  }, [onRewind, opportunities]);

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
      <div className="flex flex-col items-center justify-center h-[520px] w-full max-w-[420px] rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-4">
          <Sparkles className="h-8 w-8" />
        </div>
        <h3 className="text-xl font-bold text-foreground mb-2">
          You're All Caught Up!
        </h3>
        <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
          You have evaluated all verified remote opportunities matching your intent. Check back later or review your saved matches in the tracker.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 w-full">
          {canRewind && (
            <button
              onClick={handleRewind}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-border bg-secondary px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary/80 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              <span>Rewind</span>
            </button>
          )}
          <Link
            href="/tracker"
            className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-colors"
          >
            <span>Go to Tracker</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center justify-center w-full max-w-[440px]">
      {/* Toast Notification upon Right-Swipe */}
      <AnimatePresence>
        {showToast && lastInterestedOpp && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute -top-16 z-50 flex items-center justify-between gap-3 w-full rounded-xl border border-emerald-500/40 bg-emerald-950/90 backdrop-blur-md px-4 py-2.5 shadow-2xl text-xs"
          >
            <div className="flex items-center gap-2 text-emerald-300">
              <Check className="h-4 w-4 text-emerald-400" />
              <span className="font-semibold line-clamp-1">
                Saved & Analyzed: {lastInterestedOpp.company}
              </span>
            </div>
            <Link
              href={`/match/${lastInterestedOpp.id}`}
              className="flex items-center gap-1 font-bold text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg px-2.5 py-1 transition-colors"
            >
              <span>View Match</span>
              <ArrowRight className="h-3 w-3" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card Stack Area */}
      <div className="relative h-[520px] w-full flex items-center justify-center">
        {/* Background Card Peek */}
        {nextOpp && (
          <div className="absolute top-3 scale-[0.96] opacity-60 pointer-events-none w-full max-w-[420px]">
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
          className="absolute cursor-grab active:cursor-grabbing w-full max-w-[420px] touch-none"
        >
          {/* Visual Stamp: INTERESTED */}
          <motion.div
            style={{ opacity: interestedOpacity }}
            className="pointer-events-none absolute top-8 left-8 z-30 flex items-center gap-1 rounded-xl border-2 border-emerald-400 bg-emerald-500/20 px-4 py-1.5 text-lg font-black tracking-wider text-emerald-400 -rotate-12 shadow-lg backdrop-blur-sm"
          >
            <Check className="h-6 w-6 stroke-[3]" />
            <span>INTERESTED</span>
          </motion.div>

          {/* Visual Stamp: PASS */}
          <motion.div
            style={{ opacity: passOpacity }}
            className="pointer-events-none absolute top-8 right-8 z-30 flex items-center gap-1 rounded-xl border-2 border-rose-500 bg-rose-500/20 px-4 py-1.5 text-lg font-black tracking-wider text-rose-400 rotate-12 shadow-lg backdrop-blur-sm"
          >
            <X className="h-6 w-6 stroke-[3]" />
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
