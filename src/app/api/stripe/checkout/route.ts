import { NextRequest, NextResponse } from 'next/server';
import { createCheckoutSession } from '@/lib/stripe';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user } = auth;

  try {
    const origin = req.headers.get('origin') || 'http://localhost:3000';

    const session = await createCheckoutSession({
      userId: user.id,
      userEmail: user.email,
      returnUrl: `${origin}/settings`,
    });

    return NextResponse.json({
      success: true,
      url: session.url,
      isMock: session.isMock,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
