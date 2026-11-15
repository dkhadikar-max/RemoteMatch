import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/** The target is resolved from the caller's latest swipe inside the RPC. */
export async function POST(req: NextRequest) {
  let auth;
  try { auth = await getAuthenticatedUser(req); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { data, error } = await auth.supabase.rpc('rewind_last_decision');
  if (error) return NextResponse.json({ error: 'Could not process rewind' }, { status: 500 });

  const result = data as { success: boolean; error?: string; rewoundOpportunityId?: string };
  if (!result.success) {
    if (result.error === 'pro_required') {
      return NextResponse.json({
        error: 'pro_required', reason: 'rewind', upgradeRequired: true,
        message: 'Rewind is a Pro feature. Upgrade to Pro to revisit previous passes.',
      }, { status: 403 });
    }
    if (result.error === 'application_submitted') {
      return NextResponse.json({
        error: 'application_submitted',
        message: 'This application has already been submitted to an employer and cannot be rewound.',
      }, { status: 409 });
    }
    if (result.error === 'application_state_conflict' || result.error === 'status_conflict') {
      return NextResponse.json({
        error: result.error,
        message: 'The application changed and cannot be safely rewound. Refresh and try again.',
      }, { status: 409 });
    }
    return NextResponse.json({ success: false, rewoundOpportunityId: null });
  }

  return NextResponse.json({ success: true, rewoundOpportunityId: result.rewoundOpportunityId ?? null });
}
