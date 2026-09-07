'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, KeyRound, Send, CheckCircle2, ShieldCheck, MailCheck } from 'lucide-react';
import { signUpWithPassword, signInWithPassword, requestMagicLink, resendVerificationEmail } from '@/lib/auth/auth-flow';
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

  // Set right after a successful sign-up, in place of switching back to the
  // sign-in tab with an inline banner. Email verification is mandatory and
  // deserves its own clear step, not a footnote on the sign-in form — see
  // handleSubmit's 'signup' branch below.
  const [awaitingVerification, setAwaitingVerification] = useState<string | null>(null);
  const [resendPending, setResendPending] = useState(false);
  const [resendMessage, setResendMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
        setAwaitingVerification(email);
        return;
      }
      setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
      return;
    }

    // magiclink — sign-in only (see the tab toggle below, hidden during
    // sign-up): a passwordless way back in for an already-verified account,
    // never presented as the account-verification mechanism itself.
    const result = await requestMagicLink(email);
    setPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'Check your email for a link to continue.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  const handleResend = async () => {
    if (!awaitingVerification) return;
    setResendPending(true);
    setResendMessage(null);
    const result = await resendVerificationEmail(awaitingVerification);
    setResendPending(false);
    setResendMessage(
      result.success
        ? { type: 'success', text: 'Verification email sent again.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  if (awaitingVerification) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-1.5">
            <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
              <MailCheck size={20} />
            </div>
            <h1 className="text-xl font-bold text-[var(--ink)]">Verify your email</h1>
            <p className="text-xs text-[var(--muted)]">
              Check your email to verify your account. We sent a link to{' '}
              <span className="font-semibold text-[var(--ink)]">{awaitingVerification}</span>.
            </p>
          </div>

          <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
            <p className="text-xs text-[var(--muted)]">
              You'll need to click that link before you can sign in — verification confirms this
              email actually belongs to you.
            </p>

            {resendMessage && (
              <p
                className={`text-xs font-medium flex items-start gap-1.5 ${
                  resendMessage.type === 'success' ? 'text-[#059669]' : 'text-[var(--red)]'
                }`}
              >
                {resendMessage.type === 'success' && <CheckCircle2 size={13} className="shrink-0 mt-0.5" />}
                <span>{resendMessage.text}</span>
              </p>
            )}

            <button
              type="button"
              onClick={handleResend}
              disabled={resendPending}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <Send size={13} />
              <span>{resendPending ? 'Sending…' : 'Resend verification email'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setAwaitingVerification(null);
                setResendMessage(null);
                setMode('signin');
              }}
              className="w-full text-center text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] transition-colors py-1"
            >
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

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

            {mode === 'signup' && (
              <p className="text-[11px] text-[var(--muted)] flex items-start gap-1.5">
                <MailCheck size={13} className="shrink-0 mt-0.5" />
                <span>You'll need to verify your email before you can sign in.</span>
              </p>
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

          {/* Magic-link sign-in: passwordless re-entry for an already-verified
              account. Not offered during sign-up — verification, not magic
              links, is how a new account gets confirmed (see the note above
              the submit button and the dedicated "Verify your email" screen). */}
          {mode === 'signin' && (
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
          )}
          {mode === 'magiclink' && (
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
