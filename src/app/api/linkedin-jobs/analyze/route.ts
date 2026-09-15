import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { analyzePastedJob } from '@/lib/linkedin-jobs/analyze';
import { parsePastedPosting } from '@/lib/linkedin-jobs/parse-posting';
import type { PastedJobInput } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — "paste a job" analysis (plan §22 step [1b], §26
 * Mode B, always Free per plan §27). No vendor call, no quota RPC, no
 * spend — matches this project's precedent of keeping genuinely free,
 * zero-marginal-cost analysis ungated (Career Transition Matching's
 * Match Detail page does the same).
 *
 * Two request shapes are accepted:
 *   { rawText: string, linkedinUrl: string }  — Mode B, heuristic-parsed
 *   { title, company, description, linkedinUrl, location? } — Mode C,
 *     already-structured fields (the confirm/edit step, or a corrected
 *     Mode B result resubmitted)
 */

function isRawTextBody(body: unknown): body is { rawText: string; linkedinUrl: string } {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b.rawText === 'string' && b.rawText.trim().length > 0 && typeof b.linkedinUrl === 'string';
}

function isStructuredBody(body: unknown): body is PastedJobInput {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let input: PastedJobInput;
  if (isRawTextBody(body)) {
    const parsed = parsePastedPosting(body.rawText);
    if (!parsed.title || !parsed.company) {
      return NextResponse.json(
        { success: false, needsManualFields: true, parsed },
        { status: 200 }
      );
    }
    input = { ...parsed, linkedinUrl: body.linkedinUrl };
  } else if (isStructuredBody(body)) {
    input = body as PastedJobInput;
  } else {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  try {
    const profile = await loadServerProfile(auth.supabase, auth.user);
    const analysis = analyzePastedJob(profile, input);
    return NextResponse.json({ success: true, result: analysis });
  } catch (err) {
    console.error('[linkedin-jobs/analyze] failed:', err);
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
