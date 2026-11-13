import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { isResumeIntelligenceEnabled } from '@/lib/ai/resume-intelligence-service';

/**
 * Resume Intelligence (PR B) — accept/reject/edit one suggestion from an
 * analysis. docs/resume-intelligence-design.md §6/§8. This never itself
 * edits a resume; it only records the choice. "Create new version" (a
 * separate client action, POST /api/resume/versions with
 * source='accepted_edits') is what turns an accepted/edited suggestion into
 * real resume text.
 */

const VALID_DECISIONS = ['accepted', 'rejected', 'edited'] as const;

function isValidBody(body: unknown): body is { analysisId: string; suggestionId: string; decision: string; finalText?: string } {
  if (!body || typeof body !== 'object') return false;
  const { analysisId, suggestionId, decision, finalText } = body as Record<string, unknown>;
  if (typeof analysisId !== 'string' || analysisId.trim().length === 0) return false;
  if (typeof suggestionId !== 'string' || suggestionId.trim().length === 0 || suggestionId.length > 100) return false;
  if (typeof decision !== 'string' || !(VALID_DECISIONS as readonly string[]).includes(decision)) return false;
  if (finalText !== undefined && (typeof finalText !== 'string' || finalText.length > 2000)) return false;
  return true;
}

export async function POST(req: NextRequest) {
  if (!isResumeIntelligenceEnabled()) {
    return NextResponse.json({ error: 'Resume Intelligence is not yet available.' }, { status: 503 });
  }

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
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('record_resume_suggestion_decision', {
    p_analysis_id: body.analysisId,
    p_suggestion_id: body.suggestionId,
    p_decision: body.decision,
    p_final_text: body.finalText ?? null,
  });
  if (error) {
    // record_resume_suggestion_decision() raises 42501 for an analysisId that does not belong
    // to the caller (it does not distinguish "doesn't exist" from "belongs to someone else" —
    // deliberately, so this response never confirms which). Audit fix: surface that as an
    // explicit 403, not the generic 500 every other write failure gets, and never echo back
    // anything about the analysis itself — just the one-line message below.
    const code = (error as { code?: string }).code;
    if (code === '42501') {
      return NextResponse.json({ error: 'You do not have access to this analysis.' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Could not record your decision.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, decisionId: data as string });
}
