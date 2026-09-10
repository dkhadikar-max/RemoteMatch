'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { CanonicalOpportunity, PersonProfile, OpportunityFilters } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { fetchServerEntitlement } from '@/lib/entitlement/client';
import { hydrateLocalProfileFromServer } from '@/lib/profile/hydrate';
import { SwipeDeck } from '@/components/feed/swipe-deck';
import { FilterModal } from '@/components/feed/filter-modal';
import { UpgradeModal, UpgradeReason } from '@/components/premium/upgrade-modal';
import { applyFilters } from '@/lib/feed/apply-filters';
import { SlidersHorizontal, Check } from 'lucide-react';

export default function FeedPage() {
  const [opportunities, setOpportunities] = useState<CanonicalOpportunity[]>([]);
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [swipedCount, setSwipedCount] = useState(0);

  // Gating & Filter state
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<UpgradeReason>('rewind');
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<OpportunityFilters>({});

  // Merges the local, non-authoritative profile CONTENT fixture (skills,
  // intent, etc. — out of scope for this security pass) with the
  // server-authoritative entitlement fields (planTier/quota — never trusted
  // from localStorage). `setProfile` elsewhere in this file must always
  // preserve that merge; never overwrite entitlement fields from
  // `localStore` again.
  const loadProfile = async (): Promise<PersonProfile> => {
    const localProfile = localStore.getProfile();
    const entitlement = await fetchServerEntitlement();
    const merged: PersonProfile = entitlement
      ? {
          ...localProfile,
          planTier: entitlement.planTier,
          dailyRightSwipesCount: entitlement.dailyRightSwipesCount,
          dailyProposalsCount: entitlement.dailyProposalsCount,
          usageDate: entitlement.usageDate,
          // Career Transition Matching — server-authoritative, from /api/profile.
          // Only ever affects the additive transition-explanation layer, never
          // eligibility / fit score / ranking / the decision snapshot.
          careerDirection: entitlement.careerDirection,
        }
      : localProfile;
    setProfile(merged);
    return merged;
  };

  const refreshOpportunities = async () => {
    const currentProfile = await loadProfile();

    // Opportunity catalog now comes from the persisted, live-supply-backed
    // /api/opportunities/feed (Live Supply Activation) instead of reading
    // localStore.getOpportunities() directly — that pool was always the
    // static CURATED_JOBS array. Fit-scoring happens server-side in that
    // route (computeScreeningFit, unchanged) against THIS user's profile,
    // which is POSTed here — there is no server-authoritative store of
    // profile CONTENT, so the client supplies the profile it just loaded
    // (same advisory-only trust level as the pre-Live-Supply client-side
    // scoring). Unswiped-filtering stays exactly where it already was:
    // client-side, against the local swipe cache — see mock-seed.ts's
    // recordSwipe() comment for why that cache is display-only.
    const swipes = localStore.getSwipes();
    const swipedIds = new Set(swipes.map((s) => s.opportunityId));

    let scored: Array<CanonicalOpportunity & { fitScore?: number; fitBadge?: string }> = [];
    try {
      const res = await fetch('/api/opportunities/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: currentProfile }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        scored = (data.opportunities as typeof scored).filter((opp) => !swipedIds.has(opp.id));
      }
    } catch {
      // Network failure: show an empty deck rather than falling back to any
      // local fixture as if it were live supply.
    }

    setOpportunities(scored);
    setSwipedCount(swipes.length);
    setIsLoading(false);
  };

  useEffect(() => {
    // Decision 7a: onboarding is DB-authoritative; refill the client-local
    // profile fixture from the server before the feed reads it, so a fresh
    // device / cleared localStorage shows the real profile.
    (async () => {
      await hydrateLocalProfileFromServer();
      await refreshOpportunities();
    })();
  }, []);

  const filteredOpportunities = useMemo(() => {
    return applyFilters(opportunities, activeFilters);
  }, [opportunities, activeFilters]);

  const handleRequireUpgrade = (reason: UpgradeReason) => {
    setUpgradeReason(reason);
    setIsUpgradeModalOpen(true);
  };

  const handleSwipe = async (opportunityId: string, action: 'interested' | 'passed') => {
    // The server is the ONLY authority on whether this swipe is allowed —
    // it checks/reserves quota, runs the (frozen) matching engine, and
    // persists the decision atomically. Nothing here can grant a save.
    let res: Response;
    try {
      res = await fetch('/api/opportunities/swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId, action }),
      });
    } catch {
      // Network failure: fail closed. Do not touch local state as if the
      // swipe succeeded.
      return;
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data.error === 'limit_reached') {
        handleRequireUpgrade('swipes');
      }
      return;
    }

    // Local bookkeeping only — keeps this opportunity out of the deck on
    // reload and drives the opportunity pool's local match-score display.
    // It is never consulted for quota/entitlement decisions. The
    // "interested" application row itself is already created server-side by
    // finalize_interested_swipe(); the tracker now reads it back from
    // GET /api/applications, so no local mirror of it is written here.
    localStore.recordSwipe(opportunityId, action);

    setSwipedCount((prev) => prev + 1);
    setProfile((prev) => {
      if (!prev) return prev;
      if (action !== 'interested') return prev;
      return {
        ...prev,
        planTier: data.planTier ?? prev.planTier,
        dailyRightSwipesCount:
          typeof data.remaining === 'number' ? data.limit - data.remaining : prev.dailyRightSwipesCount,
      };
    });
  };

  const handleRewind = async (): Promise<string | null> => {
    if (profile?.planTier === 'free') {
      handleRequireUpgrade('rewind');
      return null;
    }

    let res: Response;
    try {
      res = await fetch('/api/opportunities/rewind', { method: 'POST' });
    } catch {
      return null;
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data.error === 'pro_required') handleRequireUpgrade('rewind');
      return null;
    }
    if (!data.success || !data.rewoundOpportunityId) {
      return null;
    }

    localStore.rewindLastSwipe();
    setSwipedCount((prev) => Math.max(prev - 1, 0));
    await loadProfile();
    return data.rewoundOpportunityId as string;
  };

  if (isLoading || !profile) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
          <span className="text-xs text-[var(--muted)] font-medium">
            Loading your match details...
          </span>
        </div>
      </div>
    );
  }

  const isFree = profile.planTier === 'free';
  const rightSwipesCount = profile.dailyRightSwipesCount || 0;
  const savesRemaining = Math.max(15 - rightSwipesCount, 0);
  const hasActiveFilters = Object.keys(activeFilters).length > 0;

  return (
    <div className="flex-1 flex flex-col items-center px-3 sm:px-4 py-3 sm:py-6 md:py-8 max-w-5xl mx-auto w-full">
      {/* Desktop Context Rail */}
      <div className="hidden md:flex items-center justify-between w-full max-w-[560px] mb-3 text-xs text-[var(--muted)] px-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-[var(--ink)]">Your preferences:</span>
          <span>Remote · Full-time · {profile.intent?.targetRoles[0] || 'Engineering'}</span>
        </div>
        <div className="flex items-center gap-3">
          {isFree ? (
            <span className="font-medium text-[var(--muted)]">
              {savesRemaining} saves left today
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red-soft-border)]">
              Pro
            </span>
          )}
        </div>
      </div>

      {/* Top Context & Controls Bar */}
      <div className="w-full max-w-[440px] md:max-w-[560px] flex items-center justify-between pb-3 mb-4 border-b border-[var(--line)]">
        <div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red-soft-border)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--red)]" />
            Jobs picked for you
          </span>
          <p className="text-[11px] text-[var(--muted)] mt-0.5 hidden sm:block">
            A focused list of remote opportunities matched to your experience.
          </p>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-sm font-bold text-[var(--ink)]">
              {activeFilters.targetRole || profile.intent?.targetRoles[0] || 'Full Stack Engineer'}
            </h1>
            <span className="text-xs text-[var(--muted)]/40">·</span>
            <span className="text-xs text-[var(--muted)]">
              {activeFilters.remoteType || 'Remote'}
            </span>
          </div>
        </div>

        {/* Filter Button opening FilterModal */}
        <button
          type="button"
          onClick={() => setIsFilterModalOpen(true)}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors shadow-sm min-h-[44px] ${
            hasActiveFilters
              ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)]'
              : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
          }`}
        >
          <SlidersHorizontal size={13} />
          <span>Filter</span>
          {hasActiveFilters && (
            <span className="size-1.5 rounded-full bg-[var(--red)]" />
          )}
        </button>
      </div>

      {/* Primary Swipe Deck Container (Uncompromised Core Experience) */}
      <div className="w-full flex flex-col items-center">
        <SwipeDeck
          opportunities={filteredOpportunities}
          onSwipe={handleSwipe}
          onRewind={handleRewind}
          canRewind={swipedCount > 0}
          planTier={profile.planTier}
          dailyRightSwipesCount={profile.dailyRightSwipesCount || 0}
          onRequireUpgrade={handleRequireUpgrade}
        />
      </div>

      {/* Bottom Trust Indicators: Remote · Eligible */}
      <div className="mt-6 sm:mt-8 flex items-center justify-center gap-4 text-xs text-[var(--muted)] select-none">
        <span className="flex items-center gap-1.5 font-medium text-[#059669]">
          <Check size={14} className="stroke-[3]" />
          <span>Remote</span>
        </span>
        <span className="text-[var(--muted)]/40">·</span>
        <span className="flex items-center gap-1.5 font-medium text-[#059669]">
          <Check size={14} className="stroke-[3]" />
          <span>Eligible</span>
        </span>
      </div>

      {/* Filter Modal */}
      <FilterModal
        isOpen={isFilterModalOpen}
        onClose={() => setIsFilterModalOpen(false)}
        filters={activeFilters}
        onApplyFilters={(newFilters) => setActiveFilters(newFilters)}
        planTier={profile.planTier}
        careerDirection={profile.careerDirection}
        onRequireUpgrade={handleRequireUpgrade}
      />

      {/* Soft Peach Upgrade Modal */}
      <UpgradeModal
        isOpen={isUpgradeModalOpen}
        onClose={() => setIsUpgradeModalOpen(false)}
        reason={upgradeReason}
        onUpgraded={() => {
          // Re-fetch from the server rather than trusting whatever the
          // client thinks just happened — Stripe verification is what
          // actually grants planTier, server-side.
          loadProfile();
        }}
      />
    </div>
  );
}

