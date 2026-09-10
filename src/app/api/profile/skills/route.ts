import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Resume Match Opportunities ("Grow your matches", ticket I) — the incremental
 * add-one-skill path. The user has EXPLICITLY confirmed they have the skill
 * ("Yes, add it"); this never infers possession.
 *
 * POST { skillName: string }  -> add_profile_skill() RPC (migration 016),
 *   auth.uid()-scoped, idempotent (no-op if a case-insensitive match exists).
 *
 * Deliberately NOT part of /api/onboarding / complete_onboarding (frozen, AFC) —
 * those do a full replace; this only ever appends one row.
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

  const skillName = (body as { skillName?: unknown })?.skillName;
  if (typeof skillName !== 'string' || skillName.trim() === '' || skillName.trim().length > 80) {
    return NextResponse.json({ error: 'skillName must be a non-empty string (<= 80 chars)' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('add_profile_skill', { p_skill_name: skillName.trim() });
  if (error) {
    const status = error.code === '28000' ? 401 : error.code === '23514' ? 400 : 500;
    return NextResponse.json({ error: 'Could not add skill' }, { status });
  }

  return NextResponse.json({ ok: true, skillName: data as string });
}
