import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Career Transition Matching — the only path that sets `career_direction`.
 *
 * POST { direction: 'continue' | 'change_fields' }
 *   -> set_career_direction() RPC (migration 015), auth.uid()-scoped.
 *
 * Deliberately NOT part of /api/onboarding or complete_onboarding — those are
 * frozen (AFC). This is a single-field profile-preference edit, set from
 * /settings, read back via GET /api/profile.
 */
const VALID = ['continue', 'change_fields'] as const;

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

  const direction = (body as { direction?: unknown })?.direction;
  if (typeof direction !== 'string' || !(VALID as readonly string[]).includes(direction)) {
    return NextResponse.json({ error: 'direction must be "continue" or "change_fields"' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('set_career_direction', { p_direction: direction });
  if (error) {
    const status = error.code === '28000' ? 401 : error.code === '23514' ? 400 : 500;
    return NextResponse.json({ error: 'Could not update career direction' }, { status });
  }

  return NextResponse.json({ ok: true, careerDirection: data as string });
}
