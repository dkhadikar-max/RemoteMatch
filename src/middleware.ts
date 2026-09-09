import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getJobById, isJobPermanentlyRemoved } from '@/lib/seo/data';
import { isAccountVerified } from '@/lib/auth/get-authenticated-user';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20
);

// An allowlist of what is PROTECTED (not a denylist of what is public), so a new
// public page never needs a middleware change to stay reachable.
//
//   ONBOARDING_PREFIXES — verified account required, onboarding NOT required
//                          (this is where an un-onboarded user is sent).
//   PRODUCT_PREFIXES     — verified account AND completed onboarding required.
const ONBOARDING_PREFIXES = ['/onboarding'];
const PRODUCT_PREFIXES = ['/feed', '/match', '/tracker', '/settings'];

function matchesAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Frozen SEO behavior: unchanged from the pre-remediation baseline ---
  if (pathname.startsWith('/remote-jobs/view/')) {
    const jobId = pathname.replace('/remote-jobs/view/', '').split('/')[0];
    const job = await getJobById(jobId);
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

  const inOnboarding = matchesAny(pathname, ONBOARDING_PREFIXES);
  const inProduct = matchesAny(pathname, PRODUCT_PREFIXES);

  // --- Refresh the Supabase auth session cookie on every request ---
  let response = NextResponse.next({ request });
  let verified = false;
  let userId: string | null = null;

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
    userId = user?.id ?? null;

    // --- Onboarding-state gate (UX only — the RPC + route auth are the real
    //     enforcement; this just avoids a broken/empty screen). One indexed
    //     read, only when it actually affects routing. ---
    if (verified && userId && (inProduct || inOnboarding)) {
      let onboarded = false;
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('onboarding_completed_at')
          .eq('id', userId)
          .single();
        onboarded = Boolean(profile?.onboarding_completed_at);
      } catch {
        onboarded = false;
      }

      if (inProduct && !onboarded) {
        return NextResponse.redirect(new URL('/onboarding', request.url));
      }
      if (inOnboarding && onboarded) {
        return NextResponse.redirect(new URL('/feed', request.url));
      }
    }
  }

  // --- Private-route boundary (verified) ---
  if ((inProduct || inOnboarding) && !verified) {
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
