/** A single real, DB-derived metric tile. Never render this with a
 *  hardcoded/placeholder number — callers must pass `undefined` (renders a
 *  loading skeleton) rather than a fabricated value while data is pending. */
export function StatCard({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: number | string | undefined;
  sublabel?: string;
  tone?: 'default' | 'good' | 'warn' | 'danger';
}) {
  const toneClass =
    tone === 'good' ? 'text-[var(--green-dark)]' :
    tone === 'warn' ? 'text-[var(--amber)]' :
    tone === 'danger' ? 'text-[var(--danger)]' :
    'text-[var(--ink)]';

  return (
    <div className="soft-card p-4 border border-[var(--line)]">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className={`mt-1.5 text-2xl font-bold tabular-nums ${toneClass}`}>
        {value === undefined ? (
          <span className="inline-block h-7 w-16 rounded bg-[var(--surface)] animate-pulse" />
        ) : (
          value
        )}
      </div>
      {sublabel && <div className="mt-1 text-xs text-[var(--muted)]">{sublabel}</div>}
    </div>
  );
}
