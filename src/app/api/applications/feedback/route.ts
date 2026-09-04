import { NextRequest, NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';

export async function POST(req: NextRequest) {
  try {
    const { opportunityId, didApply, notes } = await req.json();

    if (!opportunityId || !didApply) {
      return NextResponse.json({ error: 'Missing feedback fields' }, { status: 400 });
    }

    localStore.recordFeedback(opportunityId, didApply, notes);

    return NextResponse.json({
      success: true,
      message: 'Feedback and outcome event recorded successfully',
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
