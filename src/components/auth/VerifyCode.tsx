'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Send, CheckCircle2 } from 'lucide-react';
import { verifyEmailOtp, resendCode } from '@/lib/auth/auth-flow';

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const head = user.slice(0, 1);
  const tail = user.length > 2 ? user.slice(-1) : '';
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}${tail}@${domain}`;
}

/**
 * Shown by /signup and /login after a code is requested. The user types the
 * code from the email; verifyOtp establishes the session; we then navigate to
 * /feed and middleware routes by onboarding state (verified-but-not-onboarded
 * -> /onboarding). No product access exists until the code verifies.
 */
export function VerifyCode({
  email,
  onChangeEmail,
}: {
  email: string;
  onChangeEmail: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await verifyEmailOtp(email, code);
    if (result.success) {
      // Session is set. Middleware decides /onboarding vs /feed from here.
      router.push('/feed');
      return;
    }
    setPending(false);
    setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
  };

  const handleResend = async () => {
    setResendPending(true);
    setMessage(null);
    const result = await resendCode(email);
    setResendPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'New code sent — check your inbox.' }
        : { type: 'error', text: result.error || 'Something went wrong.' },
    );
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <KeyRound size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Enter your code</h1>
          <p className="text-xs text-[var(--muted)]">
            We emailed a sign-in code to{' '}
            <span className="font-semibold text-[var(--ink)]">{maskEmail(email)}</span>.
          </p>
        </div>

        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <form onSubmit={handleVerify} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">Code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste the code from your email"
                className="soft-input py-2 px-3 text-sm tracking-[0.3em] text-center"
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
              disabled={pending || !code.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <KeyRound size={13} />
              <span>{pending ? 'Verifying…' : 'Verify & continue'}</span>
            </button>
          </form>

          <button
            type="button"
            onClick={handleResend}
            disabled={resendPending}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] disabled:opacity-40 text-[var(--ink)] text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
          >
            <Send size={13} />
            <span>{resendPending ? 'Sending…' : 'Resend code'}</span>
          </button>

          <button
            type="button"
            onClick={onChangeEmail}
            className="w-full text-center text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] transition-colors py-1"
          >
            Change email
          </button>
        </div>
      </div>
    </div>
  );
}
