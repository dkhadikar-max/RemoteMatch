import { NextResponse } from 'next/server';

/**
 * Minimal, unauthenticated health/provenance endpoint. Returns the git commit
 * the running build was produced from, so a post-deploy check can prove the
 * deployed SHA is the intended one (Railway sets RAILWAY_GIT_COMMIT_SHA at
 * build time; the other names are fallbacks for other hosts / local runs).
 * A commit SHA is not sensitive — nothing else is exposed here.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    null;

  return NextResponse.json({ status: 'ok', sha, ts: new Date().toISOString() });
}
