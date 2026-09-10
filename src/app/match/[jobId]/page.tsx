'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CanonicalOpportunity, PersonProfile, MatchAnalysisResult, TailoredResumeSuggestions, MaterialTone, CareerTransitionResult } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis, checkHardEligibility } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
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
  const [resumeTweaks, setResumeTweaks] = useState<TailoredResumeSuggestions | null>(null);
  const [coverLetter, setCoverLetter] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    const opp = localStore.getOpportunityById(jobId);

    if (!opp) {
      router.push('/feed');
      return;
    }
    setOpportunity(opp);

    (async () => {
      // Profile CONTENT (skills/experience) stays on the local fixture;
      // planTier/dailyProposalsCount are overlaid from the server and are
      // the only fields this page ever gates on.
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

      // Initial kit loaded for viewing without consuming daily proposal generation quota
      const kit = await generateApplicationKit(userProfile, opp, matchRes, 'confident');
      setResumeTweaks(kit.resumeTweaks);
      setCoverLetter(kit.coverLetter);
      setIsLoading(false);
    })();
  }, [jobId, router]);

  const handleToneChange = async (tone: MaterialTone): Promise<string> => {
    if (!profile || !opportunity || !match) return '';

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

    setCoverLetter(data.coverLetter);
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
    return data.coverLetter;
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
        initialResumeTweaks={resumeTweaks}
        initialCoverLetter={coverLetter}
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
