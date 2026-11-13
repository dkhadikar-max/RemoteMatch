import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * The rewind target is selected by the database from the caller's latest
 * swipe. The client cannot name another user's opportunity or decision.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await auth.supabase.rpc('rewind_last_decision');
  if (error) {
    console.error('[opportunities/rewind] RPC failed', { code: error.code, message: error.message });
    return NextResponse.json({ error: 'Could not process rewind' }, { status: 500 });
  }

  const result = data as { success: boolean; error?: string; rewoundOpportunityId?: string } | null;
  if (!result) return NextResponse.json({ error: 'Could not confirm rewind' }, { status: 500 });

  if (!result.success) {
    if (result.error === 'pro_required') {
      return NextResponse.json({
        error: 'pro_required',
        reason: 'rewind',
        upgradeRequired: true,
        message: 'Rewind is a Pro feature. Upgrade to Pro to revisit previous passes.',
      }, { status: 403 });
    }
    if (result.error === 'application_submitted' || result.error === 'application_state_conflict' ||
        result.error === 'status_conflict') {
      return NextResponse.json({
        error: result.error,
        message: result.error === 'application_submitted'
          ? 'This decision is linked to a submitted application and cannot be rewound.'
          : 'This application has progressed and cannot be rewound.',
      }, { status: 409 });
    }
    if (result.error === 'nothing_to_rewind') {
      return NextResponse.json({ success: false, rewoundOpportunityId: null });
    }
    return NextResponse.json({ error: 'Could not process rewind' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    rewoundOpportunityId: result.rewoundOpportunityId ?? null,
  });
}
