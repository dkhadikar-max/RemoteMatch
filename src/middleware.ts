import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getJobById, isJobPermanentlyRemoved } from '@/lib/seo/data';
import { isAccountVerified } from '@/lib/auth/get-authenticated-user';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20
);

// Exactly the private/product surface named in the spec. Everything else —
// '/', '/remote-jobs/*', '/guide/*', and any other route — stays public,
// including this list's absence covering them (an allowlist of what's
// PROTECTED, not a denylist of what's public, so a new public page never
// needs a middleware change to stay reachable).
const PROTECTED_PREFIXES = ['/onboarding', '/feed', '/match', '/tracker', '/settings'];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

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

  // --- Refresh the Supabase auth session cookie on every request ---
  // Required by @supabase/ssr so a JWT nearing expiry is rotated before an
  // API route or Server Component reads it.
  let response = NextResponse.next({ request });
  let verified = false;

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

    const {
      data: { user },
    } = await supabase.auth.getUser();
    verified = Boolean(user && isAccountVerified(user));
  }

  // --- Private-route boundary ---
  // Middleware alone is not sufficient protection (a direct API request
  // bypasses it entirely) — getAuthenticatedUser() enforces the identical
  // invariant server-side for every mutation. This redirect exists purely
  // for UX: an unverified visitor gets sent to sign in instead of seeing a
  // broken/empty page.
  if (isProtectedPath(pathname) && !verified) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|txt|xml)$).*)',
  ],
};
