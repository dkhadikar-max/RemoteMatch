import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { MAX_ANALYSIS_CHARS } from '@/lib/resume/rubric';
import { isResumeIntelligenceEnabled } from '@/lib/ai/resume-intelligence-service';

/**
 * Resume Intelligence (PR B) — create or return-existing a resume version.
 * docs/resume-intelligence-design.md §6. Server computes the sha256 itself
 * (never trusts a client-supplied hash); create_resume_version() is
 * idempotent on (profile_id, sha256), so a re-submit of identical text is a
 * cheap no-op, not a duplicate row.
 */

const VALID_SOURCES = ['onboarding', 'upload', 'paste', 'accepted_edits'] as const;

function isValidBody(body: unknown): body is { content: string; source: string; parentVersionId?: string } {
  if (!body || typeof body !== 'object') return false;
  const { content, source, parentVersionId } = body as Record<string, unknown>;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_ANALYSIS_CHARS) return false;
  if (typeof source !== 'string' || !(VALID_SOURCES as readonly string[]).includes(source)) return false;
  if (parentVersionId !== undefined && typeof parentVersionId !== 'string') return false;
  return true;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

  const sha256 = await sha256Hex(body.content.trim());
  const { data, error } = await supabase.rpc('create_resume_version', {
    p_content: body.content.trim(),
    p_sha256: sha256,
    p_source: body.source,
    p_parent_version_id: body.parentVersionId ?? null,
  });
  if (error) {
    return NextResponse.json({ error: 'Could not save this resume version.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, versionId: data as string });
}
