import type { Metadata } from 'next';

/**
 * Outermost /admin/** layout — deliberately minimal. Its only job is to
 * override the root layout's consumer metadata (title, indexability) with
 * a static object for every page under /admin, WITHOUT reading request
 * headers (see src/app/layout.tsx's own header comment for why that
 * matters — this segment renders for /admin/** on any host, but the
 * Navbar hides itself client-side and middleware.ts already blocks
 * /admin/** entirely on the consumer host, so no host check is needed
 * here either). The sidebar/auth-gated shell lives one level deeper, in
 * src/app/admin/(dashboard)/layout.tsx, so /admin/login (outside that
 * route group) never gets a sidebar or an auth requirement to render.
 */
export const metadata: Metadata = {
  // `absolute` bypasses the root layout's '%s | RemoteMatch' title template
  // (which would otherwise render "RemoteMatch Admin | RemoteMatch") — this
  // is a distinct application, not a templated page of the consumer site.
  title: { absolute: 'RemoteMatch Admin' },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">{children}</div>;
}
