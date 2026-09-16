import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/admin/Sidebar';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';

/**
 * The REAL server-side enforcement for every /admin/** page (not just UX —
 * middleware.ts's own admin_users check is explicitly UX-only there, same
 * relationship it already has to onboarding routing). Every request to any
 * page under this route group resolves getAuthenticatedAdmin() itself;
 * anything short of an active admin redirects to /admin/login. A route
 * group ((dashboard)) rather than a plain nested folder so /admin/login
 * sits OUTSIDE this gate entirely — it needs no session and no sidebar.
 */
export default async function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  let adminEmail: string;
  try {
    const admin = await getAuthenticatedAdmin();
    adminEmail = admin.adminEmail;
  } catch {
    redirect('/admin/login');
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar adminEmail={adminEmail} />
      <main className="min-w-0 flex-1 p-5 md:p-8">{children}</main>
    </div>
  );
}
