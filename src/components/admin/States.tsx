/** Real loading/empty/error states — no admin table/panel silently renders
 *  nothing or a fabricated placeholder while data is missing or failed. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--muted)]">
      <span className="size-4 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
      {label}
    </div>
  );
}

export function EmptyState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <div className="text-sm font-medium text-[var(--ink)]">{label}</div>
      {hint && <div className="text-xs text-[var(--muted)]">{hint}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; hint?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-sm font-medium text-[var(--danger)]">{message}</div>
      {onRetry && (
        <button onClick={onRetry} className="soft-button secondary text-xs px-3 py-1.5">
          Retry
        </button>
      )}
    </div>
  );
}
