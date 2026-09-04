import { NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';
import { computeScreeningFit } from '@/lib/matching/engine';

export async function GET() {
  try {
    const profile = localStore.getProfile();
    const opportunities = localStore.getOpportunities();
    const swipes = localStore.getSwipes();
    const swipedIds = new Set(swipes.map((s) => s.opportunityId));

    const unswiped = opportunities.filter((o) => !swipedIds.has(o.id));

    const scored = unswiped.map((opp) => {
      const fit = computeScreeningFit(profile, opp);
      return {
        ...opp,
        fitScore: fit.fitScore,
        fitBadge: fit.fitBadge,
      };
    });

    scored.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

    return NextResponse.json({
      success: true,
      opportunities: scored,
      dailyCount: profile.dailyEvaluationsCount,
      remaining: Math.max(20 - (profile.dailyEvaluationsCount || 0), 0),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
