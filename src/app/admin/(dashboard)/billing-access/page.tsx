'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface AccessRow {
  user_id: string;
  email: string | null;
  granted_by_email: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_by_email: string | null;
  note: string | null;
  active: boolean;
  deploymentAllows: boolean;
}

const MODE_TEXT: Record<string, string> = {
  open: 'not set — it does not restrict anyone',
  closed: 'set but empty — it blocks every purchase',
  list: 'set to a list of user ids — only those users can pass it',
};

export default function BillingAccessPage() {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantNote, setGrantNote] = useState('');
  const [grantPending, setGrantPending] = useState(false);
  const [grantMessage, setGrantMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessRow | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/billing-access');
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.access);
      setMode(data.deploymentAllowlist?.mode ?? null);
      setTruncated(Boolean(data.truncated));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    setGrantPending(true);
    setGrantMessage(null);
    const res = await fetch('/api/admin/billing-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: grantEmail, note: grantNote || undefined }),
    });
    setGrantPending(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setGrantMessage({ text: body.error || 'Grant failed. Nothing was changed.', tone: 'error' });
      return;
    }
    const base = body.changed ? `Granted to ${body.email}.` : `${body.email} already had access; nothing changed.`;
    setGrantMessage({
      text: body.deploymentAllows ? base : `${base} Note: the deployment allowlist still blocks this user, so they cannot purchase yet.`,
      tone: 'ok',
    });
    setGrantEmail('');
    setGrantNote('');
    load();
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevokePending(true);
    setRevokeError(null);
    const res = await fetch(`/api/admin/billing-access/${revokeTarget.user_id}`, { method: 'DELETE' });
    setRevokePending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setRevokeError(body.error || 'Revoke failed. Nothing was changed.');
      return;
    }
    setRevokeTarget(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Billing Access</h1>
        <p className="text-xs text-[var(--muted)]">
          Who may start a Pro purchase. A purchase needs an active grant here AND the deployment allowlist to allow the user.
          Every change is audit-logged. Revoking only stops new purchases; it does not cancel a subscription or remove Pro.
        </p>
      </div>

      {mode && (
        <section className="soft-card border border-[var(--line)] p-4 text-xs text-[var(--ink)]">
          Deployment allowlist (RAZORPAY_ALLOWLIST_USER_IDS) is {MODE_TEXT[mode] ?? mode}.
        </section>
      )}

      <section className="soft-card border border-[var(--line)] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Grant purchase access</h2>
        <form onSubmit={grant} className="flex flex-wrap gap-2">
          <input
            type="email"
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="existing-user@example.com"
            required
            className="soft-input px-2.5 py-1.5 text-xs flex-1 min-w-[220px]"
          />
          <input
            type="text"
            value={grantNote}
            onChange={(e) => setGrantNote(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={500}
            className="soft-input px-2.5 py-1.5 text-xs flex-1 min-w-[160px]"
          />
          <button type="submit" disabled={grantPending || !grantEmail} className="soft-button primary text-xs px-3 py-1.5 disabled:opacity-40">
            {grantPending ? 'Granting…' : 'Grant'}
          </button>
        </form>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">Must be an existing RemoteMatch account — this never creates one.</p>
        {grantMessage && (
          <p className={`mt-1.5 text-xs font-medium ${grantMessage.tone === 'error' ? 'text-[var(--danger)]' : 'text-[var(--ink)]'}`}>
            {grantMessage.text}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Access</h2>
        {truncated && <p className="mb-2 text-xs text-[var(--danger)]">Showing the first 1,000 rows only.</p>}
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows === null ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">Nobody has purchase access yet, so nobody can start a purchase.</p>
        ) : (
          <div className="soft-card divide-y divide-[var(--line)] border border-[var(--line)]">
            {rows.map((r) => (
              <div key={r.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-[var(--ink)] break-all">{r.email ?? r.user_id}</div>
                  <div className="text-[10px] text-[var(--muted)]">
                    granted {new Date(r.granted_at).toLocaleDateString()} by {r.granted_by_email}
                    {r.revoked_at ? ` · revoked ${new Date(r.revoked_at).toLocaleDateString()}${r.revoked_by_email ? ` by ${r.revoked_by_email}` : ''}` : ''}
                    {r.note ? ` · ${r.note}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {r.active && !r.deploymentAllows && <StatusBadge label="Blocked by deployment" tone="danger" />}
                  <StatusBadge label={r.active ? 'Active' : 'Revoked'} tone={r.active ? 'good' : 'neutral'} />
                  {r.active && (
                    <button onClick={() => setRevokeTarget(r)} className="rounded-lg bg-[var(--danger)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!revokeTarget}
        title={`Revoke purchase access for ${revokeTarget?.email ?? revokeTarget?.user_id ?? ''}?`}
        description="They will no longer be able to start a Pro purchase. An existing subscription is not cancelled. This is audit-logged."
        confirmLabel="Revoke"
        pending={revokePending}
        onConfirm={revoke}
        onCancel={() => { setRevokeTarget(null); setRevokeError(null); }}
      />
      {revokeError && <p className="text-xs font-medium text-[var(--danger)]">{revokeError}</p>}
    </div>
  );
}
