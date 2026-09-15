import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateConnectionMessageDraft } from '@/lib/ai/connection-message';
import { normalizePastedJob } from '@/lib/linkedin-jobs/normalize';

/**
 * LinkedIn Job Finder — connection-message draft (plan §22 step [4], §28
 * point 3, §27 Pro-only). Gated server-side on a fresh `profiles.plan_tier`
 * read — the SAME robust pattern as transitionLayerAllowed() (src/app/api/
 * opportunities/feed/route.ts), not the weaker client-only `isPro` check
 * the plan explicitly flags as an anti-pattern (§27).
 *
 * Job fields are re-supplied by the client (title/company/description/
 * linkedinUrl — whatever the user is currently looking at, from either the
 * search or paste flow) and re-normalized/re-matched server-side rather
 * than trusting a client-supplied match result, consistent with this
 * project's standing rule that AI-relevant computed state is never client-
 * trusted.
 */

async function isProUser(supabase: Awaited<ReturnType<typeof getAuthenticatedUser>>['supabase'], userId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('profiles').select('plan_tier').eq('id', userId).single();
    return (data?.plan_tier as string | undefined) === 'pro';
  } catch {
    return false;
  }
}

function isValidBody(body: unknown): body is { title: string; company: string; description: string; linkedinUrl: string; location?: string } {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.title === 'string' && b.title.trim().length > 0 &&
    typeof b.company === 'string' && b.company.trim().length > 0 &&
    typeof b.description === 'string' && b.description.trim().length > 0 &&
    typeof b.linkedinUrl === 'string' && b.linkedinUrl.trim().length > 0
  );
}

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase, user } = auth;

  const allowed = await isProUser(supabase, user.id);
  if (!allowed) {
    return NextResponse.json(
      {
        error: 'pro_required',
        reason: 'linkedinPeopleConnect',
        upgradeRequired: true,
        message: 'Connection-message drafts are a Pro feature.',
      },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  try {
    const profile = await loadServerProfile(supabase, user);
    const { opportunity } = normalizePastedJob(body);
    const match = generateRuleBasedMatchAnalysis(profile, opportunity);
    const draft = await generateConnectionMessageDraft(profile, opportunity, match);
    return NextResponse.json({ success: true, message: draft.message, source: draft.source });
  } catch (err) {
    console.error('[linkedin-jobs/connection-message] failed:', err);
    return NextResponse.json({ error: 'Draft generation failed' }, { status: 500 });
  }
}
