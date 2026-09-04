import { NextRequest, NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { MaterialTone } from '@/types/byn';

export async function POST(req: NextRequest) {
  try {
    const { opportunityId, tone = 'confident' } = await req.json();

    const profile = localStore.getProfile();
    const opp = localStore.getOpportunityById(opportunityId);

    if (!opp) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
    }

    const match = generateRuleBasedMatchAnalysis(profile, opp);
    const kit = await generateApplicationKit(profile, opp, match, tone as MaterialTone);

    return NextResponse.json({
      success: true,
      match,
      resumeTweaks: kit.resumeTweaks,
      coverLetter: kit.coverLetter,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
