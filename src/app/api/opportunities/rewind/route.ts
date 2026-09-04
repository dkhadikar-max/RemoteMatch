import { NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';

export async function POST() {
  try {
    const rewoundId = localStore.rewindLastSwipe();
    const profile = localStore.getProfile();

    return NextResponse.json({
      success: Boolean(rewoundId),
      rewoundOpportunityId: rewoundId,
      dailyCount: profile.dailyEvaluationsCount,
      remaining: Math.max(20 - (profile.dailyEvaluationsCount || 0), 0),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
