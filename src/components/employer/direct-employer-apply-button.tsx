'use client';

import { useState } from 'react';

export function DirectEmployerApplyButton({ sourceId }: { sourceId: string }) {
  const [coverNote, setCoverNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [replayed, setReplayed] = useState(false);

  const apply = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/employer-jobs/' + sourceId + '/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, coverNote }),
      });
      const data = await response.json();
      if (response.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
        return;
      }
      // Show the readable message; the error field is a machine code such as application_conflict.
      if (!response.ok) throw new Error(data.message || data.error || 'Could not submit application.');
      setReplayed(Boolean(data.replayed));
      setMessage(data.replayed
        ? 'You have already applied to this job. The employer can see your application.'
        : 'Application submitted. The employer can now review your profile.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-2">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-[var(--muted)]">Message to employer (optional)</span>
        <textarea className="soft-input w-full px-3 py-2 text-sm" rows={3} maxLength={10000}
          value={coverNote} onChange={e => setCoverNote(e.target.value)}
          placeholder="Briefly explain why you are a fit for this role." />
      </label>
      <button type="button" onClick={apply} disabled={busy || Boolean(message)}
        className="soft-button primary text-sm w-full disabled:opacity-50">
        {busy ? 'Submitting…' : message ? (replayed ? 'Already applied' : 'Application submitted') : 'Apply on RemoteMatch'}
      </button>
      {message && <p role="status" className="text-xs text-green-700">{message}</p>}
      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
