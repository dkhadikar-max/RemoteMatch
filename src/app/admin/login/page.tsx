'use client';

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ShieldCheck, LogIn } from 'lucide-react';
import { signInWithPassword } from '@/lib/auth/auth-flow';

/**
 * Reuses the EXISTING signInWithPassword() unchanged — Supabase Auth stays
 * the one identity system; nothing new is invented for credential
 * handling here. Authorization (is this account an active admin?) is a
 * SEPARATE, server-side check that runs on every subsequent request, not
 * something this page decides — a successful sign-in here only proves
 * "a real, verified RemoteMatch account," exactly like the consumer
 * /login. If middleware.ts already redirected here with ?forbidden=1
 * (a verified-but-non-admin session hit /admin/**), that's surfaced
 * plainly rather than silently retried.
 */
function AdminLoginContent() {
  const searchParams = useSearchParams();
  const forbidden = searchParams?.get('forbidden') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    forbidden ? 'That account is signed in, but is not authorized for admin access.' : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await signInWithPassword(email, password);
    if (result.success) {
      // Full-document navigation — same reasoning as the consumer login:
      // guarantees middleware sees the fresh session cookie on the very
      // first hit, so the admin_users check runs against a real session.
      window.location.replace('/admin');
      return;
    }
    setPending(false);
    setError(result.error || 'Something went wrong.');
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <ShieldCheck size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">RemoteMatch Admin</h1>
          <p className="text-xs text-[var(--muted)]">Sign in with your admin account.</p>
        </div>

        <div className="soft-card space-y-4 border border-[var(--line)] p-6">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink)]">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="soft-input px-3 py-2 text-xs"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink)]">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="soft-input px-3 py-2 text-xs"
                autoComplete="current-password"
              />
            </div>

            {error && <p className="text-xs font-medium text-[var(--danger)]">{error}</p>}

            <button
              type="submit"
              disabled={pending || !email || !password}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] px-3.5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--red-dark)] disabled:opacity-40"
            >
              <LogIn size={13} />
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><span className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" /></div>}>
      <AdminLoginContent />
    </Suspense>
  );
}
