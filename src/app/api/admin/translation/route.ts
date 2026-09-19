import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows, must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

interface StatusRow {
  id: string;
  translation_status: string | null;
  source_language: string | null;
}

/** Read-only — status breakdown + a page of error rows. Never returns
 *  DEEPL_API_KEY/GEMINI_API_KEY or any credential; those env vars are
 *  never read by this route at all.
 *
 *  The breakdown reads EVERY active row (paginated). It previously used an
 *  un-ranged select that PostgREST silently capped at 1,000 rows, so the
 *  "not yet processed" figure was a sample, not a count. Any query failure
 *  is now an explicit 500, never an empty breakdown. */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  try {
    const [statusRows, errorRes] = await Promise.all([
      fetchAllRows<StatusRow>(
        (afterId, pageSize) => {
          let q = admin
            .from('opportunities')
            .select('id, translation_status, source_language')
            .eq('status', 'active')
            .order('id', { ascending: true })
            .limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'opportunities.translation_status' }
      ),
      admin
        .from('opportunities')
        .select('id, title, company, source, source_language, translated_at')
        .eq('translation_status', 'error')
        .order('translated_at', { ascending: false })
        .limit(50),
    ]);
    const errorRows = must(errorRes, 'opportunities.translation_errors').data ?? [];

    const byStatus: Record<string, number> = {};
    const byLanguage: Record<string, number> = {};
    for (const row of statusRows) {
      const s = row.translation_status ?? 'not_yet_processed';
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      if (row.source_language) byLanguage[row.source_language] = (byLanguage[row.source_language] ?? 0) + 1;
    }

    return NextResponse.json({
      activeTotal: statusRows.length,
      byStatus,
      byLanguage,
      errors: errorRows,
    });
  } catch (err) {
    return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
