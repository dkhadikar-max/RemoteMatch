'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Send, CheckCircle2, KeyRound } from 'lucide-react';
import { requestPasswordReset } from '@/lib/auth/auth-flow';

/**
 * Reachable both by a forgotten password AND by every account created
 * before password login existed (the Auth Flow Change made every existing
 * account passwordless) — for that second case this is really "set your
 * password for the first time," not just recovery, but the mechanism
 * (emailed link -> /auth/confirm -> /reset-password) is identical either
 * way, so one flow serves both.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await requestPasswordReset(email);
    setPending(false);
    if (result.success) {
      setSent(true);
      return;
    }
    setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
  };

  if (sent) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <CheckCircle2 size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Check your email</h1>
          <p className="text-xs text-[var(--muted)]">
            If an account exists for <span className="font-semibold text-[var(--ink)]">{email}</span>, we&apos;ve
            sent a link to set a new password.
          </p>
          <Link href="/login" className="inline-block text-xs font-semibold text-[var(--red)] hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <KeyRound size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Reset your password</h1>
          <p className="text-xs text-[var(--muted)]">
            Enter your email and we&apos;ll send you a link to set a new password.
          </p>
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

            {message && (
              <p className="text-xs font-medium text-[var(--red)]">{message.text}</p>
            )}

            <button
              type="submit"
              disabled={pending || !email}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <Send size={13} />
              <span>{pending ? 'Sending…' : 'Send reset link'}</span>
            </button>
          </form>

          <p className="text-center text-xs text-[var(--muted)]">
            <Link href="/login" className="font-semibold text-[var(--red)] hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
