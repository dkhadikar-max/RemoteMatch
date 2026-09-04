import { NextRequest, NextResponse } from 'next/server';
import {
  submitToIndexNow,
  notifyJobPublished,
  notifyJobUpdated,
  notifyJobExpired,
  verifyInternalSecret,
} from '@/lib/seo/indexnow';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || req.headers.get('X-Internal-Secret');
  if (!verifyInternalSecret(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized: Internal secret required for IndexNow dispatch.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { action, jobId, urls } = body;

    if (action === 'publish' && jobId) {
      const result = await notifyJobPublished(jobId);
      return NextResponse.json(result);
    }

    if (action === 'update' && jobId) {
      const result = await notifyJobUpdated(jobId);
      return NextResponse.json(result);
    }

    if (action === 'expire' && jobId) {
      const result = await notifyJobExpired(jobId);
      return NextResponse.json(result);
    }

    if (Array.isArray(urls)) {
      const result = await submitToIndexNow(urls);
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: 'Bad Request: Missing valid action ("publish", "update", "expire") or url list.' },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
