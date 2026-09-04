'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CanonicalOpportunity, PersonProfile, MatchAnalysisResult, TailoredResumeSuggestions, MaterialTone } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { generateJobSpecificResumeAnalysis } from '@/lib/ai/resume-intelligence';
import { MatchAnalysisView } from '@/components/match/match-analysis-view';

export default function MatchDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params?.jobId as string;

  const [opportunity, setOpportunity] = useState<CanonicalOpportunity | null>(null);
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [match, setMatch] = useState<MatchAnalysisResult | null>(null);
  const [resumeTweaks, setResumeTweaks] = useState<TailoredResumeSuggestions | null>(null);
  const [coverLetter, setCoverLetter] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!jobId) return;

    const userProfile = localStore.getProfile();
    const opp = localStore.getOpportunityById(jobId);

    if (!opp) {
      router.push('/feed');
      return;
    }

    setProfile(userProfile);
    setOpportunity(opp);

    // Compute or retrieve match
    const matchRes = generateRuleBasedMatchAnalysis(userProfile, opp);

    // Attach job-specific resume improvements
    matchRes.jobSpecificResumeImprovements = generateJobSpecificResumeAnalysis(userProfile, opp);
    setMatch(matchRes);

    // Generate initial kit
    generateApplicationKit(userProfile, opp, matchRes, 'confident').then((kit) => {
      setResumeTweaks(kit.resumeTweaks);
      setCoverLetter(kit.coverLetter);
      setIsLoading(false);
    });
  }, [jobId, router]);

  const handleToneChange = async (tone: MaterialTone): Promise<string> => {
    if (!profile || !opportunity || !match) return '';
    const kit = await generateApplicationKit(profile, opportunity, match, tone);
    setCoverLetter(kit.coverLetter);
    return kit.coverLetter;
  };

  const handleRecordFeedback = (didApply: any, notes?: string) => {
    if (opportunity) {
      localStore.recordFeedback(opportunity.id, didApply, notes);
    }
  };

  if (isLoading || !opportunity || !match || !resumeTweaks) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-xs text-muted-foreground font-medium">
            Generating deep match analysis and tailored proposal...
          </span>
        </div>
      </div>
    );
  }

  return (
    <MatchAnalysisView
      opportunity={opportunity}
      match={match}
      initialResumeTweaks={resumeTweaks}
      initialCoverLetter={coverLetter}
      onToneChange={handleToneChange}
      onRecordFeedback={handleRecordFeedback}
    />
  );
}
