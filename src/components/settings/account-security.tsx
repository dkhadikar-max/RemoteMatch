'use client';

import React, { useState } from 'react';
import { ShieldCheck, Mail, KeyRound, Send, LogOut, CheckCircle2 } from 'lucide-react';
import {
  linkEmailWithPassword,
  linkEmailMagicLink,
  signInWithPasswordCredential,
  requestSignInMagicLink,
  signOutCurrentSession,
} from '@/lib/auth/link-identity';

type Mode = 'cta' | 'link-password' | 'link-magiclink' | 'signin-password' | 'signin-magiclink';

interface AccountSecuritySectionProps {
  email: string | null;
  isAnonymous: boolean;
  /** Compact banner variant (post-upgrade) vs. full section (Settings tab). */
  variant?: 'full' | 'compact';
  /** Only meaningful for the compact variant — the full Settings section is
   *  always available, not something to dismiss. */
  onDismiss?: () => void;
}

const DISMISS_KEY = 'remotematch_security_prompt_dismissed';

export function shouldShowPostUpgradePrompt(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) !== 'true';
  } catch {
    return true;
  }
}

function dismissPostUpgradePrompt() {
  try {
    localStorage.setItem(DISMISS_KEY, 'true');
  } catch {
    /* best-effort UI preference only, not security-relevant */
  }
}

export function AccountSecuritySection({ email, isAnonymous, variant = 'full', onDismiss }: AccountSecuritySectionProps) {
  const [mode, setMode] = useState<Mode>('cta');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const compact = variant === 'compact';

  const reset = () => {
    setMode('cta');
    setEmailInput('');
    setPasswordInput('');
    setMessage(null);
  };

  const handleDismiss = () => {
    dismissPostUpgradePrompt();
    onDismiss?.();
  };

  const handleLinkPassword = async () => {
    setPending(true);
    setMessage(null);
    const result = await linkEmailWithPassword(emailInput, passwordInput);
    setPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'Check your email to confirm and finish securing your account.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  const handleLinkMagicLink = async () => {
    setPending(true);
    setMessage(null);
    const result = await linkEmailMagicLink(emailInput);
    setPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'Check your email for a link to finish securing your account.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  const handleSignInPassword = async () => {
    setPending(true);
    setMessage(null);
    const result = await signInWithPasswordCredential(emailInput, passwordInput);
    setPending(false);
    if (result.success) {
      window.location.reload();
      return;
    }
    setMessage({ type: 'error', text: result.error || 'Something went wrong.' });
  };

  const handleSignInMagicLink = async () => {
    setPending(true);
    setMessage(null);
    const result = await requestSignInMagicLink(emailInput);
    setPending(false);
    setMessage(
      result.success
        ? { type: 'success', text: 'Check your email for a sign-in link.' }
        : { type: 'error', text: result.error || 'Something went wrong.' }
    );
  };

  const handleSignOut = async () => {
    await signOutCurrentSession();
    window.location.reload();
  };

  // --- Already linked: show account + sign out, no linking UI. ---
  if (!isAnonymous) {
    return (
      <div className={compact ? '' : 'soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]'}>
        {!compact && (
          <h2 className="text-lg font-bold text-[var(--ink)] flex items-center gap-2">
            <ShieldCheck size={18} className="text-[#059669]" />
            Account secured
          </h2>
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-[var(--muted)]">
            Signed in as <span className="font-semibold text-[var(--ink)]">{email}</span>. Your profile, saved
            jobs, applications, and plan will be here if you switch devices or clear your browser.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--muted)] hover:text-[var(--ink)] text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px]"
          >
            <LogOut size={13} />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? 'rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3' : 'soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]'}>
      {mode === 'cta' && (
        <>
          <div>
            <h2 className={compact ? 'text-sm font-bold text-[var(--ink)] flex items-center gap-2' : 'text-lg font-bold text-[var(--ink)] flex items-center gap-2'}>
              <ShieldCheck size={compact ? 15 : 18} className="text-[var(--red)]" />
              Secure your account
            </h2>
            <p className="text-xs text-[var(--muted)] mt-1">
              Protect your RemoteMatch profile, saved jobs, applications, and Pro access if you change devices or
              clear your browser data.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMode('link-password')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px]"
            >
              <KeyRound size={13} />
              <span>Use a password</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('link-magiclink')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--ink)] text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px]"
            >
              <Send size={13} />
              <span>Use a magic link</span>
            </button>
            {compact && (
              <button
                type="button"
                onClick={handleDismiss}
                className="text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] px-2 py-2 min-h-[44px]"
              >
                Maybe later
              </button>
            )}
          </div>
          {!compact && (
            <p className="text-[11px] text-[var(--muted)] pt-1">
              Already have an account?{' '}
              <button type="button" onClick={() => setMode('signin-password')} className="font-semibold text-[var(--red)] hover:underline">
                Sign in
              </button>
            </p>
          )}
        </>
      )}

      {(mode === 'link-password' || mode === 'link-magiclink' || mode === 'signin-password' || mode === 'signin-magiclink') && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-[var(--ink)]">
            {mode === 'link-password' && 'Set an email + password'}
            {mode === 'link-magiclink' && 'Continue with a magic link'}
            {mode === 'signin-password' && 'Sign in with password'}
            {mode === 'signin-magiclink' && 'Sign in with a magic link'}
          </h3>

          <div>
            <label className="text-xs font-medium text-[var(--ink)] block mb-1">Email</label>
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@example.com"
              className="soft-input py-2 px-3 text-xs"
            />
          </div>

          {(mode === 'link-password' || mode === 'signin-password') && (
            <div>
              <label className="text-xs font-medium text-[var(--ink)] block mb-1">Password</label>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={mode === 'link-password' ? 'Choose a password' : 'Your password'}
                className="soft-input py-2 px-3 text-xs"
              />
            </div>
          )}

          {message && (
            <p className={`text-xs font-medium flex items-center gap-1.5 ${message.type === 'success' ? 'text-[#059669]' : 'text-[var(--red)]'}`}>
              {message.type === 'success' && <CheckCircle2 size={13} className="shrink-0" />}
              <span>{message.text}</span>
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending || !emailInput || ((mode === 'link-password' || mode === 'signin-password') && !passwordInput)}
              onClick={
                mode === 'link-password'
                  ? handleLinkPassword
                  : mode === 'link-magiclink'
                  ? handleLinkMagicLink
                  : mode === 'signin-password'
                  ? handleSignInPassword
                  : handleSignInMagicLink
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px]"
            >
              <Mail size={13} />
              <span>{pending ? 'Working…' : 'Continue'}</span>
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] px-2 py-2 min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
