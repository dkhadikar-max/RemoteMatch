import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

/** Read-only — status breakdown + a page of error rows. Never returns
 *  DEEPL_API_KEY/GEMINI_API_KEY or any credential; those env vars are
 *  never read by this route at all. */
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

  const [statusRows, errorRows] = await Promise.all([
    admin.from('opportunities').select('translation_status, source_language').eq('status', 'active'),
    admin
      .from('opportunities')
      .select('id, title, company, source, source_language, translated_at')
      .eq('translation_status', 'error')
      .order('translated_at', { ascending: false })
      .limit(50),
  ]);

  const byStatus: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const row of statusRows.data ?? []) {
    const s = row.translation_status ?? 'not_yet_processed';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (row.source_language) byLanguage[row.source_language] = (byLanguage[row.source_language] ?? 0) + 1;
  }

  return NextResponse.json({
    byStatus,
    byLanguage,
    errors: errorRows.data ?? [],
  });
}
