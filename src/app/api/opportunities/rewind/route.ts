import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Takes no body/params by design: the target of a rewind is never something
 * the client gets to name (there is no jobId to spoof), and the identity
 * performing it comes only from the verified session — see
 * public.rewind_last_decision() in supabase/migrations/003_security_remediation.sql
 * for the Pro-gating, ownership, atomicity, and one-shot-replay guarantees.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase } = auth;

  const { data, error } = await supabase.rpc('rewind_last_decision');
  if (error) {
    return NextResponse.json({ error: 'Could not process rewind' }, { status: 500 });
  }

  const result = data as { success: boolean; error?: string; rewoundOpportunityId?: string };

  if (!result.success) {
    if (result.error === 'pro_required') {
      return NextResponse.json(
        {
          error: 'pro_required',
          reason: 'rewind',
          upgradeRequired: true,
          message: 'Rewind is a Pro feature. Upgrade to Pro to revisit previous passes.',
        },
        { status: 403 }
      );
    }
    // 'nothing_to_rewind': not an error condition — there is simply no
    // decision left to undo (already rewound, or no swipes yet today).
    return NextResponse.json({ success: false, rewoundOpportunityId: null });
  }

  return NextResponse.json({
    success: true,
    rewoundOpportunityId: result.rewoundOpportunityId ?? null,
  });
}
