'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CanonicalOpportunity, PersonProfile, MatchAnalysisResult, TailoredResumeSuggestions, MaterialTone, CareerTransitionResult } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { hydrateLocalProfileFromServer } from '@/lib/profile/hydrate';
import { generateRuleBasedMatchAnalysis, checkHardEligibility } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
import { deriveActionableSkillGaps } from '@/lib/match/actionable-skill-gaps';
import type { ActionableSkillGap } from '@/lib/match/actionable-skill-gaps';
import { generateApplicationKit } from '@/lib/ai/materials';
import { generateJobSpecificResumeAnalysis } from '@/lib/ai/resume-intelligence';
import { fetchServerEntitlement } from '@/lib/entitlement/client';
import { MatchAnalysisView } from '@/components/match/match-analysis-view';
import { UpgradeModal } from '@/components/premium/upgrade-modal';

export default function MatchDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params?.jobId as string;

  const [opportunity, setOpportunity] = useState<CanonicalOpportunity | null>(null);
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [match, setMatch] = useState<MatchAnalysisResult | null>(null);
  const [careerTransition, setCareerTransition] = useState<CareerTransitionResult | null>(null);
  const [actionableGaps, setActionableGaps] = useState<ActionableSkillGap[]>([]);
  const [resumeTweaks, setResumeTweaks] = useState<TailoredResumeSuggestions | null>(null);
  const [resumeTweaksSource, setResumeTweaksSource] = useState<'ai' | 'template'>('template');
  const [coverLetter, setCoverLetter] = useState<string>('');
  const [coverLetterSource, setCoverLetterSource] = useState<'ai' | 'template'>('template');
  const [isLoading, setIsLoading] = useState(true);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    (async () => {
      // M-adj-2(a) — Data-source/navigation integrity: resolves the
      // opportunity from the real, live, active catalog
      // (GET /api/opportunities/feed — existing, public, unscored; no new
      // API route). NEVER falls back to CURATED_JOBS/localStore — that
      // static fixture is no longer the authoritative resolver for this
      // page at all, for any source, curated included (a curated id now
      // resolves through the exact same path as a remotive/arbeitnow/
      // jobicy one). A fetch failure and a genuinely absent/inactive id
      // both fall through to the SAME existing not-found redirect below,
      // unchanged from before this fix.
      let opp: CanonicalOpportunity | null = null;
      try {
        const res = await fetch('/api/opportunities/feed');
        const data = await res.json();
        if (res.ok && data.success) {
          opp = (data.opportunities as CanonicalOpportunity[]).find((o) => o.id === jobId) ?? null;
        }
      } catch {
        // network failure -> opp stays null; falls through to the same
        // redirect as "not found", never to any local fixture.
      }

      if (!opp) {
        router.push('/feed');
        return;
      }
      setOpportunity(opp);

      // J4 — Unified Search Profile: this page used to read localStore
      // directly, with no guarantee it had ever been hydrated (feed/page.tsx
      // is the only other caller of hydrateLocalProfileFromServer, and a
      // direct/bookmarked link here could skip it entirely) — silently
      // falling back to DEFAULT_DEMO_PROFILE. Hydrate first, same function
      // feed/page.tsx already uses, so Match Detail reflects the real server
      // profile whenever one exists. planTier/dailyProposalsCount are still
      // overlaid from the server below and are the only fields this page
      // ever gates on.
      await hydrateLocalProfileFromServer();
      const localProfile = localStore.getProfile();
      const entitlement = await fetchServerEntitlement();
      const userProfile: PersonProfile = entitlement
        ? {
            ...localProfile,
            planTier: entitlement.planTier,
            dailyRightSwipesCount: entitlement.dailyRightSwipesCount,
            dailyProposalsCount: entitlement.dailyProposalsCount,
            usageDate: entitlement.usageDate,
            careerDirection: entitlement.careerDirection,
          }
        : localProfile;
      setProfile(userProfile);

      // Compute or retrieve match — v1 engine, unchanged.
      const matchRes = generateRuleBasedMatchAnalysis(userProfile, opp);

      // Attach job-specific resume improvements
      matchRes.jobSpecificResumeImprovements = generateJobSpecificResumeAnalysis(userProfile, opp);
      setMatch(matchRes);

      // Additive Career Transition explanation (change_fields users only).
      const isEligible = checkHardEligibility(userProfile, opp).isEligible;
      setCareerTransition(classifyCareerTransition(userProfile, opp, isEligible));

      // L3 — actionable skill gaps, derived independently of engine.ts
      // (no import of/into engine.ts), mirroring how careerTransition above
      // is already computed page-side and passed down as a prop.
      setActionableGaps(deriveActionableSkillGaps(userProfile, opp));

      // Initial kit loaded for viewing without consuming daily proposal generation quota.
      // O3: this always runs client-side, where GEMINI_API_KEY is never
      // available (Next.js only inlines NEXT_PUBLIC_-prefixed vars into
      // client bundles) — kit.source is therefore always 'template' here.
      // Kept as a real field (not hardcoded) so this stays correct even if
      // that execution boundary ever changes.
      const kit = await generateApplicationKit(userProfile, opp, matchRes, 'confident');
      setResumeTweaks(kit.resumeTweaks);
      setResumeTweaksSource(kit.source);
      setCoverLetter(kit.coverLetter);
      setCoverLetterSource(kit.source);
      setIsLoading(false);
    })();
  }, [jobId, router]);

  const handleToneChange = async (tone: MaterialTone): Promise<{ coverLetter: string; source: 'ai' | 'template' }> => {
    if (!profile || !opportunity || !match) return { coverLetter: '', source: 'template' };

    // The server is the only entitlement authority here: it atomically
    // reserves one proposal-generation unit BEFORE calling the AI, and
    // rolls the reservation back if generation fails (see
    // src/app/api/ai/match-analysis/route.ts). There is deliberately no
    // client-side pre-check and no local-generation fallback on failure —
    // both were exploitable bypasses of the 5/day limit (a pre-check reads
    // client state, and a "fallback" on a failed/blocked fetch generated
    // full content without ever consulting the server).
    let res: Response;
    try {
      res = await fetch('/api/ai/match-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId: opportunity.id, tone }),
      });
    } catch {
      throw new Error('network_error');
    }

    if (res.status === 403) {
      setIsUpgradeModalOpen(true);
      throw new Error('limit_reached');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.coverLetter) {
      throw new Error(data.error || 'generation_failed');
    }

    // O1: this now reflects generation against the real, server-loaded
    // profile (loadServerProfile), not the demo fixture. O4: `data.source`
    // is 'ai' only when the model's response passed the anti-fabrication
    // check; otherwise the route already fell back to the deterministic
    // template and reports that honestly.
    const source: 'ai' | 'template' = data.source === 'ai' ? 'ai' : 'template';
    setCoverLetter(data.coverLetter);
    setCoverLetterSource(source);
    const entitlement = await fetchServerEntitlement();
    if (entitlement) {
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              planTier: entitlement.planTier,
              dailyRightSwipesCount: entitlement.dailyRightSwipesCount,
              dailyProposalsCount: entitlement.dailyProposalsCount,
              usageDate: entitlement.usageDate,
            }
          : prev
      );
    }
    return { coverLetter: data.coverLetter, source };
  };

  const handleRecordFeedback = (didApply: any, notes?: string) => {
    if (opportunity) {
      // Server-authoritative and ownership-scoped — see
      // record_application_feedback() in
      // supabase/migrations/006_outcome_lifecycle.sql. Previously called
      // localStore.recordFeedback(), which had no auth check and mutated a
      // module-level singleton that never persisted anything server-side.
      fetch('/api/applications/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId: opportunity.id, didApply, notes }),
      }).catch(() => {
        // Best-effort from this screen's perspective, same as before — the
        // route itself is now real, but this call site doesn't block on it.
      });
    }
  };

  if (isLoading || !opportunity || !match || !resumeTweaks || !profile) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
          <span className="text-xs text-[var(--muted)] font-medium">
            Loading your match details...
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <MatchAnalysisView
        opportunity={opportunity}
        match={match}
        careerTransition={careerTransition}
        yearsOfExperience={profile.intent?.yearsOfExperience}
        actionableGaps={actionableGaps}
        initialResumeTweaks={resumeTweaks}
        initialCoverLetter={coverLetter}
        resumeTweaksSource={resumeTweaksSource}
        initialCoverLetterSource={coverLetterSource}
        onToneChange={handleToneChange}
        onRecordFeedback={handleRecordFeedback}
        planTier={profile.planTier}
        dailyProposalsCount={profile.dailyProposalsCount || 0}
        onRequireUpgrade={() => setIsUpgradeModalOpen(true)}
      />

      <UpgradeModal
        isOpen={isUpgradeModalOpen}
        onClose={() => setIsUpgradeModalOpen(false)}
        reason="proposals"
        onUpgraded={async () => {
          const entitlement = await fetchServerEntitlement();
          if (entitlement) {
            setProfile((prev) =>
              prev
                ? {
                    ...prev,
                    planTier: entitlement.planTier,
                    dailyRightSwipesCount: entitlement.dailyRightSwipesCount,
                    dailyProposalsCount: entitlement.dailyProposalsCount,
                    usageDate: entitlement.usageDate,
                    isAnonymous: entitlement.isAnonymous,
                    linkedinUrl: entitlement.linkedinUrl,
                    githubUrl: entitlement.githubUrl,
                  }
                : prev
            );
          }
        }}
      />
    </>
  );
}
