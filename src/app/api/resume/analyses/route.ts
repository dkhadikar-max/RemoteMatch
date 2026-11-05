import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { getActiveOpportunityByCanonicalId } from '@/lib/ingestion/catalog-read';
import { analyzeResume, isResumeIntelligenceEnabled } from '@/lib/ai/resume-intelligence-service';
import { aiAnalysisAllowed } from '@/lib/resume/entitlement';

/**
 * Resume Intelligence (PR B) — request (or fetch cached) an analysis for
 * one resume version, in general or target-job mode. docs/
 * resume-intelligence-design.md §2/§7. The profile (full name, declared
 * skills) comes from loadServerProfile — the caller never supplies the
 * content fed to the model, only which stored version + which job to
 * analyse against; this mirrors /api/ai/match-analysis's trust boundary.
 *
 * WORKSTREAM 2 (2026-10-30, docs/resume-pr-b-workstream2-pro-entitlement-plan-2026-10-30.md):
 * AI-powered analysis is Pro-only (the commercial decision already on record). This route
 * establishes that fact server-side via aiAnalysisAllowed() (src/lib/resume/entitlement.ts) —
 * the SAME established pattern already used by two other Pro-gated features in this codebase
 * (opportunities/feed's transitionLayerAllowed(), linkedin-jobs/connection-message's inline
 * check): a fresh, per-request `profiles.plan_tier` read, fail-closed. NOT
 * `loadServerProfile()` — that function's `planTier` field is a hardcoded `'free'` stub (see
 * src/lib/profile/server-profile.ts:89), never read from the database; using it here would
 * have silently denied every real Pro user. A Free user still gets the full deterministic
 * rules-only analysis — this only decides whether the AI layer is attempted. (The check lives
 * in its own module, not inlined here, because Next.js's App Router route-type validation
 * rejects a route.ts file that exports anything other than an HTTP method handler or a small
 * fixed set of config names.)
 */

function isValidBody(body: unknown): body is { resumeVersionId: string; mode: 'general' | 'target_job'; opportunityId?: string } {
  if (!body || typeof body !== 'object') return false;
  const { resumeVersionId, mode, opportunityId } = body as Record<string, unknown>;
  if (typeof resumeVersionId !== 'string' || resumeVersionId.trim().length === 0) return false;
  if (mode !== 'general' && mode !== 'target_job') return false;
  if (mode === 'target_job' && (typeof opportunityId !== 'string' || opportunityId.trim().length === 0)) return false;
  if (opportunityId !== undefined && typeof opportunityId !== 'string') return false;
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
  const { user, supabase } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  // Ownership check: the version must belong to the caller (RLS already enforces this on
  // SELECT, but an explicit check gives a clean 404 instead of a confusing empty result).
  const { data: version, error: versionError } = await supabase
    .from('resume_versions')
    .select('id, content')
    .eq('id', body.resumeVersionId)
    .maybeSingle();
  if (versionError || !version) {
    return NextResponse.json({ error: 'Resume version not found' }, { status: 404 });
  }

  const profile = await loadServerProfile(supabase, user);
  const declaredSkills = profile.skills.map((s) => s.skillName).filter((n): n is string => typeof n === 'string');
  const aiAllowed = await aiAnalysisAllowed(supabase, user.id);

  let jobText: string | undefined;
  if (body.mode === 'target_job' && body.opportunityId) {
    const opp = await getActiveOpportunityByCanonicalId(supabase, body.opportunityId);
    if (!opp) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
    }
    jobText = `${opp.title}\n\n${opp.description}`;
  }

  const result = await analyzeResume(supabase, {
    profileId: user.id,
    fullName: profile.fullName ?? null,
    declaredSkills,
    resumeVersionId: version.id,
    resumeText: version.content as string,
    mode: body.mode,
    opportunityId: body.opportunityId,
    jobText,
    aiAllowed,
  });

  return NextResponse.json({
    success: true,
    status: result.status,
    cached: result.cached,
    analysisId: result.analysisId,
    persisted: result.persisted,
    analysis: result.analysis,
    quota: result.quota,
  });
}
