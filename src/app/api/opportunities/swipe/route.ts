import { NextRequest, NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';

export async function POST(req: NextRequest) {
  try {
    const { opportunityId, action } = await req.json();

    if (!opportunityId || !['interested', 'passed'].includes(action)) {
      return NextResponse.json({ error: 'Invalid swipe parameters' }, { status: 400 });
    }

    localStore.recordSwipe(opportunityId, action);
    const profile = localStore.getProfile();

    if (action === 'interested') {
      const opp = localStore.getOpportunityById(opportunityId);
      if (opp) {
        const matchResult = generateRuleBasedMatchAnalysis(profile, opp);
        const appKit = await generateApplicationKit(profile, opp, matchResult, 'confident');

        localStore.saveApplication({
          id: `app-${Date.now()}`,
          profileId: profile.id,
          opportunityId: opp.id,
          opportunity: opp,
          match: matchResult,
          status: 'interested',
          notes: '',
          decisionSnapshot: {
            fitScore: matchResult.fitScore,
            fitBadge: matchResult.fitBadge,
            isEligible: matchResult.isCountryEligible && matchResult.isRemoteEligible,
            decisionTimestamp: new Date().toISOString(),
            matchingEngineVersion: 'v1.0.0-beta',
            matchingWeightsVersion: 'weights-2026.09-v1',
            eligibilityRulesVersion: 'rules-2026.09-v1',
            profileVersion: profile.updatedAt || new Date().toISOString(),
            jobVersion: opp.lastVerifiedAt || opp.postedAt,
            jobSource: opp.source,
            jobSourceId: opp.sourceId,
            officialUrl: opp.officialUrl,
            employmentType: opp.employmentType,
            remoteClassification: opp.remoteType,
            requirementsEvaluated: matchResult.requirementChecklist.map((r) => ({
              requirement: r.requirement,
              status: r.status,
            })),
            scoreBreakdown: {
              roleMatch: matchResult.isRoleMatch ? 95 : 60,
              recommendation: matchResult.recommendation,
              strengthsCount: matchResult.strengths.length,
              gapsCount: matchResult.gaps.length,
            },
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({
      success: true,
      dailyCount: profile.dailyEvaluationsCount,
      remaining: Math.max(20 - (profile.dailyEvaluationsCount || 0), 0),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
