'use client';

import React, { useState, useEffect } from 'react';
import { CanonicalOpportunity, PersonProfile } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { computeScreeningFit, generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { SwipeDeck } from '@/components/feed/swipe-deck';
import { Sparkles, SlidersHorizontal, AlertCircle } from 'lucide-react';
import Link from 'next/link';

export default function FeedPage() {
  const [opportunities, setOpportunities] = useState<CanonicalOpportunity[]>([]);
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [swipedCount, setSwipedCount] = useState(0);

  useEffect(() => {
    // Load profile and opportunities
    const userProfile = localStore.getProfile();
    setProfile(userProfile);

    const allOpps = localStore.getOpportunities();
    const swipes = localStore.getSwipes();
    const swipedIds = new Set(swipes.map((s) => s.opportunityId));

    // Filter unswiped and compute Screening Fit Scores
    const unswiped = allOpps.filter((o) => !swipedIds.has(o.id));

    const scored = unswiped.map((opp) => {
      const fit = computeScreeningFit(userProfile, opp);
      return {
        ...opp,
        fitScore: fit.fitScore,
        fitBadge: fit.fitBadge,
      };
    });

    // Sort by Fit Score descending (highest fit opportunities first)
    scored.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

    setOpportunities(scored);
    setSwipedCount(swipes.length);
    setIsLoading(false);
  }, []);

  const handleSwipe = async (opportunityId: string, action: 'interested' | 'passed') => {
    localStore.recordSwipe(opportunityId, action);
    setSwipedCount((prev) => prev + 1);

    if (action === 'interested' && profile) {
      const opp = localStore.getOpportunityById(opportunityId);
      if (opp) {
        // Run deep match analysis & background kit generation
        const matchResult = generateRuleBasedMatchAnalysis(profile, opp);
        const appKit = await generateApplicationKit(profile, opp, matchResult, 'confident');

        // Save to applications table in store
        localStore.saveApplication({
          id: `app-${Date.now()}`,
          profileId: profile.id,
          opportunityId: opp.id,
          opportunity: opp,
          match: matchResult,
          status: 'interested',
          notes: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  };

  const handleRewind = async (): Promise<string | null> => {
    const rewoundId = localStore.rewindLastSwipe();
    if (rewoundId) {
      setSwipedCount((prev) => Math.max(prev - 1, 0));
    }
    return rewoundId;
  };

  if (isLoading || !profile) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-xs text-muted-foreground font-medium">
            Computing Fit Scores across remote opportunities...
          </span>
        </div>
      </div>
    );
  }

  const remainingEvaluations = Math.max(20 - (profile.dailyEvaluationsCount || 0), 0);

  return (
    <div className="flex-1 flex flex-col items-center px-4 py-6 sm:px-6">
      {/* Subheader: Profile Filter Summary & Remaining Quota */}
      <div className="w-full max-w-[440px] flex items-center justify-between mb-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-foreground">
            {profile.intent?.targetRoles[0] || 'Software Roles'}
          </span>
          <span>•</span>
          <span className="text-emerald-400 font-medium">{profile.location?.workPreference || 'Worldwide'}</span>
        </div>

        <Link
          href="/onboarding"
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="h-3 w-3" />
          <span>Filters</span>
        </Link>
      </div>

      {/* Daily Quota Alert if low */}
      {remainingEvaluations <= 3 && remainingEvaluations > 0 && (
        <div className="w-full max-w-[440px] mb-4 flex items-center justify-between gap-2 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-400" />
            <span>Only {remainingEvaluations} free evaluations left today.</span>
          </div>
          <Link
            href="/settings?tab=billing"
            className="font-bold underline hover:text-white"
          >
            Upgrade
          </Link>
        </div>
      )}

      {/* Swipe Deck */}
      <SwipeDeck
        opportunities={opportunities}
        onSwipe={handleSwipe}
        onRewind={handleRewind}
        canRewind={swipedCount > 0}
      />
    </div>
  );
}
