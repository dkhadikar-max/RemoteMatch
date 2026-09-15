'use client';

import React, { useState } from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { setNewPassword } from '@/lib/auth/auth-flow';

/**
 * Reached only after /auth/confirm has already exchanged a Supabase
 * recovery link for a real session (type=recovery routes here instead of
 * /feed — see that route). This page does not itself verify anything; it
 * only calls supabase.auth.updateUser({ password }) against the session
 * /auth/confirm just established. If no session exists (a stale/reused
 * link, or this page visited directly), updateUser() fails and the error
 * message below tells the user to request a fresh link.
 */
export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (password !== confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords don’t match.' });
      return;
    }
    setPending(true);
    const result = await setNewPassword(password);
    if (result.success) {
      // Full-document navigation — same reasoning as the login/VerifyCode
      // flows: guarantees middleware sees the now-password-bearing session
      // on the very first hit.
      window.location.replace('/feed');
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
            <KeyRound size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Set a new password</h1>
          <p className="text-xs text-[var(--muted)]">Choose a password for your account.</p>
        </div>

        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">New password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="soft-input py-2 px-3 text-xs"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">Confirm password</label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Retype your password"
                className="soft-input py-2 px-3 text-xs"
                autoComplete="new-password"
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
              disabled={pending || password.length < 8 || !confirmPassword}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <KeyRound size={13} />
              <span>{pending ? 'Saving…' : 'Save password'}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
