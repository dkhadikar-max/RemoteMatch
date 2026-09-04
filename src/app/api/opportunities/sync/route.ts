import { NextRequest, NextResponse } from 'next/server';
import { IngestionManager } from '@/lib/ingestion/pipeline';

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const shouldAudit = searchParams.get('audit') === 'true';

    const manager = new IngestionManager();
    const result = await manager.runIngestion();

    let auditedActive = result.opportunities.length;
    let stales = 0;

    if (shouldAudit) {
      const auditRes = await manager.auditLinkFreshness(result.opportunities);
      auditedActive = auditRes.active.length;
      stales = auditRes.stale.length;
    }

    return NextResponse.json({
      success: true,
      message: 'Ingestion pipeline executed successfully',
      totalFetched: result.totalFetched,
      totalUnique: result.totalUnique,
      count: auditedActive,
      staleLinksPurged: stales,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
