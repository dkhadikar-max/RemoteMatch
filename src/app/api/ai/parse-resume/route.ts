import { NextRequest, NextResponse } from 'next/server';
import { parseResumeWithGemini } from '@/lib/ai/resume';

export async function POST(req: NextRequest) {
  try {
    const { rawText } = await req.json();

    if (!rawText || typeof rawText !== 'string') {
      return NextResponse.json({ error: 'Text content is required' }, { status: 400 });
    }

    const result = await parseResumeWithGemini(rawText);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
