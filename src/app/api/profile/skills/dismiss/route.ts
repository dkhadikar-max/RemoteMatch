import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { normalizeSkillKey } from '@/lib/resume/skill-opportunities';

/**
 * Resume Match Opportunities ("Grow your matches", ticket I) — the "I don't
 * have this" path. Records a per-user dismissal so the suggestion list stops
 * re-surfacing a skill the user rejected. It does NOT change the profile.
 *
 * POST { skillKey: string }  -> dismiss_profile_skill() RPC (migration 016).
 * The key is normalized here with the SAME function the suggestion list uses,
 * so a dismissal always lines up with what was shown.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const raw = (body as { skillKey?: unknown })?.skillKey;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim().length > 80) {
    return NextResponse.json({ error: 'skillKey must be a non-empty string (<= 80 chars)' }, { status: 400 });
  }
  const key = normalizeSkillKey(raw);

  const { data, error } = await supabase.rpc('dismiss_profile_skill', { p_skill_key: key });
  if (error) {
    const status = error.code === '28000' ? 401 : error.code === '23514' ? 400 : 500;
    return NextResponse.json({ error: 'Could not dismiss skill' }, { status });
  }

  return NextResponse.json({ ok: true, skillKey: data as string });
}
