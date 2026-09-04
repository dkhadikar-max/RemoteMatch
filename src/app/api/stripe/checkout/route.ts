import { NextRequest, NextResponse } from 'next/server';
import { createCheckoutSession } from '@/lib/stripe';
import { localStore } from '@/lib/db/mock-seed';

export async function POST(req: NextRequest) {
  try {
    const profile = localStore.getProfile();
    const origin = req.headers.get('origin') || 'http://localhost:3000';

    const session = await createCheckoutSession({
      userId: profile.id,
      userEmail: profile.email,
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
