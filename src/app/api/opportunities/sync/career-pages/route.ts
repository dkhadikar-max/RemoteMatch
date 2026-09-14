import { NextRequest, NextResponse } from 'next/server';
import { syncCareerPageOpportunities, verifyCareerPageSyncSecret } from '@/lib/ingestion/career-page-sync';

/**
 * Supply Discovery gate C5 (docs/c5-implementation-plan.md §9) — independent
 * sync route, deliberately separate from POST /api/opportunities/sync.
 * Its own secret (CAREER_PAGE_SYNC_SECRET), its own orchestration function
 * (syncCareerPageOpportunities(), never syncOpportunitiesToCatalog()), and
 * intended to be triggered by its OWN, separate Railway cron service at a
 * daily cadence — never folded into the existing ATS/aggregator cron, per
 * C4-1/C4-3. Railway cron configuration is dashboard-only; creating that
 * service is a post-implementation step for Deep, same as every prior cron
 * ticket.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || req.headers.get('X-Internal-Secret');
  if (!verifyCareerPageSyncSecret(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized: internal secret required for career-page sync.' },
      { status: 401 }
    );
  }

  try {
    const result = await syncCareerPageOpportunities();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
