'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/admin/States';

interface AdminRow {
  id: string;
  email: string;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
}

export default function SettingsPage() {
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantPending, setGrantPending] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminRow | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/admins');
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setAdmins(data.admins);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    setGrantPending(true);
    setGrantError(null);
    const res = await fetch('/api/admin/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: grantEmail }),
    });
    setGrantPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setGrantError(body.error || 'Grant failed.');
      return;
    }
    setGrantEmail('');
    load();
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevokePending(true);
    setRevokeError(null);
    const res = await fetch(`/api/admin/admins/${revokeTarget.id}`, { method: 'DELETE' });
    setRevokePending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setRevokeError(body.error || 'Revoke failed.');
      return;
    }
    setRevokeTarget(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Settings</h1>
        <p className="text-xs text-[var(--muted)]">Admin console membership. No secrets are ever shown here.</p>
      </div>

      <section className="soft-card border border-[var(--line)] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Grant admin access</h2>
        <form onSubmit={grant} className="flex flex-wrap gap-2">
          <input
            type="email"
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="existing-user@example.com"
            required
            className="soft-input px-2.5 py-1.5 text-xs flex-1 min-w-[220px]"
          />
          <button type="submit" disabled={grantPending || !grantEmail} className="soft-button primary text-xs px-3 py-1.5 disabled:opacity-40">
            {grantPending ? 'Granting…' : 'Grant'}
          </button>
        </form>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">Must be an existing, verified RemoteMatch account — this never creates a new one.</p>
        {grantError && <p className="mt-1.5 text-xs font-medium text-[var(--danger)]">{grantError}</p>}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Admins</h2>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : admins === null ? (
          <LoadingState />
        ) : (
          <div className="soft-card divide-y divide-[var(--line)] border border-[var(--line)]">
            {admins.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
                <div>
                  <div className="font-medium text-[var(--ink)]">{a.email}</div>
                  <div className="text-[10px] text-[var(--muted)]">
                    granted {new Date(a.granted_at).toLocaleDateString()}{a.granted_by ? ` by ${a.granted_by}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge label={a.revoked_at ? 'Revoked' : 'Active'} tone={a.revoked_at ? 'neutral' : 'good'} />
                  {!a.revoked_at && (
                    <button onClick={() => setRevokeTarget(a)} className="rounded-lg bg-[var(--danger)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">
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
        title={`Revoke admin access for ${revokeTarget?.email ?? ''}?`}
        description="They will immediately lose access to the admin console. This is audit-logged."
        confirmLabel="Revoke"
        pending={revokePending}
        onConfirm={revoke}
        onCancel={() => { setRevokeTarget(null); setRevokeError(null); }}
      />
      {revokeError && <p className="text-xs font-medium text-[var(--danger)]">{revokeError}</p>}
    </div>
  );
}
