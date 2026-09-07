'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, KeyRound, Send, CheckCircle2, ShieldCheck } from 'lucide-react';
import { signUpWithPassword, signInWithPassword, requestMagicLink } from '@/lib/auth/auth-flow';
import { sanitizeRedirectPath } from '@/lib/auth/sanitize-redirect';

type Mode = 'signin' | 'signup' | 'magiclink';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Untrusted input — see sanitizeRedirectPath's docstring for why this
  // can't just be used as-is even though middleware only ever writes its
  // own request path here: a crafted link can set this param directly.
  const redirectTo = sanitizeRedirectPath(searchParams?.get('redirect'));
  const verifiedParam = searchParams?.get('verified');

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    verifiedParam === 'error'
      ? { type: 'error', text: "That confirmation link didn't work — it may have expired. Try again below." }
      : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);

    if (mode === 'signin') {
      const result = await signInWithPassword(email, password);
      setPending(false);
      if (result.success) {
        router.push(redirectTo);
        return;
      }
      setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
      return;
    }

    if (mode === 'signup') {
      const result = await signUpWithPassword(email, password);
      setPending(false);
      if (result.success) {
        setMessage({
          type: 'success',
          text: 'Check your email to confirm your account, then come back and sign in.',
        });
        setMode('signin');
        return;
      }
      setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
      return;
    }

    // magiclink
    const result = await requestMagicLink(email);
    setPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'Check your email for a link to continue.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <ShieldCheck size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">
            {mode === 'signup' ? 'Create your account' : 'Sign in to RemoteMatch'}
          </h1>
          <p className="text-xs text-[var(--muted)]">
            Your saved jobs, applications, and plan live on your account.
          </p>
        </div>

        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <div className="flex rounded-xl border border-[var(--line)] p-1 bg-[var(--surface-soft)] text-xs font-semibold">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setMessage(null);
              }}
              className={`flex-1 rounded-lg py-2 transition-colors ${
                mode === 'signin' ? 'bg-[var(--surface)] text-[var(--ink)] shadow-sm' : 'text-[var(--muted)]'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setMessage(null);
              }}
              className={`flex-1 rounded-lg py-2 transition-colors ${
                mode === 'signup' ? 'bg-[var(--surface)] text-[var(--ink)] shadow-sm' : 'text-[var(--muted)]'
              }`}
            >
              Sign up
            </button>
          </div>

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
              />
            </div>

            {mode !== 'magiclink' && (
              <div>
                <label className="text-xs font-medium text-[var(--ink)] block mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'Choose a password' : 'Your password'}
                  className="soft-input py-2 px-3 text-xs"
                />
              </div>
            )}

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
              disabled={pending || !email || (mode !== 'magiclink' && !password)}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <KeyRound size={13} />
              <span>
                {pending
                  ? 'Working…'
                  : mode === 'signup'
                  ? 'Create account'
                  : mode === 'magiclink'
                  ? 'Send magic link'
                  : 'Sign in'}
              </span>
            </button>
          </form>

          {mode !== 'magiclink' ? (
            <button
              type="button"
              onClick={() => {
                setMode('magiclink');
                setMessage(null);
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--ink)] text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <Send size={13} />
              <span>Use a magic link instead</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setMessage(null);
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--ink)] text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <Mail size={13} />
              <span>Use a password instead</span>
            </button>
          )}
        </div>
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
