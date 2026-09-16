'use client';

import { useState } from 'react';

/**
 * No confirmation-dialog pattern exists anywhere else in this codebase
 * (confirmed by inspection) — this is new, purpose-built for the admin
 * console's "every destructive action requires explicit confirmation"
 * requirement. `requireReason` forces the admin to type a real reason
 * (not just click a button) before the confirm button enables — used for
 * every mutation this console performs (opportunity force-expire, C6
 * reject, admin revoke), matching the server-side requirement that these
 * routes reject a missing/empty reason too (never trust the client alone).
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  danger = true,
  requireReason = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  pending?: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');

  if (!open) return null;

  const canConfirm = !pending && (!requireReason || reason.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="soft-card animate-modal w-full max-w-sm border border-[var(--line)] p-5">
        <h2 className="text-sm font-bold text-[var(--ink)]">{title}</h2>
        <p className="mt-1.5 text-xs text-[var(--muted)]">{description}</p>

        {requireReason && (
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            rows={3}
            className="soft-input mt-3 w-full py-2 px-3 text-xs"
            autoFocus
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} disabled={pending} className="soft-button secondary text-xs px-3 py-1.5">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}
            disabled={!canConfirm}
            className={`text-xs px-3 py-1.5 rounded-xl font-semibold text-white disabled:opacity-40 ${
              danger ? 'bg-[var(--danger)] hover:opacity-90' : 'bg-[var(--red)] hover:bg-[var(--red-dark)]'
            }`}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
