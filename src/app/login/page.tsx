'use client';

import React, { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { LogIn, CheckCircle2, ShieldCheck } from 'lucide-react';
import { signInWithPassword } from '@/lib/auth/auth-flow';
import { sanitizeRedirectPath } from '@/lib/auth/sanitize-redirect';

function LoginContent() {
  const searchParams = useSearchParams();
  const verifiedParam = searchParams?.get('verified');
  const redirectParam = searchParams?.get('redirect');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    verifiedParam === 'error'
      ? { type: 'error', text: "That link didn’t work — it may have expired or already been used." }
      : null,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await signInWithPassword(email, password);
    if (result.success) {
      // Full-document navigation, NOT router.push: signInWithPassword has
      // written the auth cookie synchronously by the time it resolves, and
      // a top-level request is guaranteed to carry it — so middleware sees
      // the session on the first hit and routes to /onboarding or /feed.
      // A client-side push can out-run cookie propagation to the
      // middleware RSC fetch and briefly bounce the just-signed-in user
      // back through /login. Same pattern VerifyCode already used.
      window.location.replace(sanitizeRedirectPath(redirectParam));
      return;
    }
    setPending(false);
    setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <ShieldCheck size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Sign in to RemoteMatch</h1>
          <p className="text-xs text-[var(--muted)]">Enter your email and password.</p>
        </div>

        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="soft-input py-2 px-3 text-xs"
                autoComplete="email"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-[var(--ink)]">Password</label>
                <Link href="/forgot-password" className="text-xs font-semibold text-[var(--red)] hover:underline">
                  Forgot password?
                </Link>
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="soft-input py-2 px-3 text-xs"
                autoComplete="current-password"
              />
            </div>

            {message && (
              <p
                className={`text-xs font-medium flex items-start gap-1.5 ${
                  message.type === 'success' ? 'text-[#059669]' : 'text-[var(--red)]'
                }`}
              >
                {message.type === 'success' && <CheckCircle2 size={13} className="shrink-0 mt-0.5" />}
                <span>{message.text}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={pending || !email || !password}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <LogIn size={13} />
              <span>{pending ? 'Signing in…' : 'Sign in'}</span>
            </button>
          </form>

          <p className="text-center text-xs text-[var(--muted)]">
            New here?{' '}
            <Link href="/signup" className="font-semibold text-[var(--red)] hover:underline">
              Create an account
            </Link>
          </p>
        </div>

        <p className="text-center text-[11px] text-[var(--muted)] leading-relaxed">
          Signed up before we added passwords? Use{' '}
          <Link href="/forgot-password" className="font-semibold text-[var(--red)] hover:underline">
            Forgot password
          </Link>{' '}
          to set one for your existing account.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
