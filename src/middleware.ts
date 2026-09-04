import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getJobById, isJobPermanentlyRemoved } from '@/lib/seo/data';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20
);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Frozen SEO behavior: unchanged from the pre-remediation baseline ---
  // Handle permanently removed jobs with HTTP 410 Gone
  if (pathname.startsWith('/remote-jobs/view/')) {
    const jobId = pathname.replace('/remote-jobs/view/', '').split('/')[0];
    const job = getJobById(jobId);
    if (job && isJobPermanentlyRemoved(job)) {
      return new NextResponse(
        `410 Gone: The job listing "${job.title}" at ${job.company} has been permanently removed.`,
        {
          status: 410,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        }
      );
    }
  }

  // --- New: refresh the Supabase auth session cookie on every request ---
  // Required by @supabase/ssr so a JWT nearing expiry is rotated before an
  // API route or Server Component reads it; does not itself grant or check
  // any authorization — it only keeps the session cookie current.
  let response = NextResponse.next({ request });

  if (isSupabaseConfigured) {
    const supabase = createServerClient(supabaseUrl!, supabaseAnonKey!, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    await supabase.auth.getUser();
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|txt|xml)$).*)',
  ],
};
