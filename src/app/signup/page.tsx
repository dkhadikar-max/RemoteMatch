'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import { startPasswordlessSignup } from '@/lib/auth/auth-flow';
import { VerifyCode } from '@/components/auth/VerifyCode';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await startPasswordlessSignup(name, email);
    setPending(false);
    if (result.success) {
      setSentTo(email);
      return;
    }
    setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
  };

  if (sentTo) {
    return (
      <VerifyCode
        email={sentTo}
        onChangeEmail={() => {
          // Keep the name; just let them fix the address.
          setSentTo(null);
          setMessage(null);
        }}
      />
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <ShieldCheck size={20} />
          </div>
          <h1 className="text-xl font-bold text-[var(--ink)]">Create your account</h1>
          <p className="text-xs text-[var(--muted)]">
            No password. We&apos;ll email you a code, then you set up your profile.
          </p>
        </div>

        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="soft-input py-2 px-3 text-xs"
                autoComplete="name"
              />
            </div>
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
              disabled={pending || !name.trim() || !email}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
            >
              <span>{pending ? 'Sending…' : 'Continue'}</span>
              <ArrowRight size={13} />
            </button>
          </form>

          <p className="text-center text-xs text-[var(--muted)]">
            Already have an account?{' '}
            <Link href="/login" className="font-semibold text-[var(--red)] hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
