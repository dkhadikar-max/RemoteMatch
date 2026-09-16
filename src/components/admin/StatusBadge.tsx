export type StatusTone = 'good' | 'warn' | 'danger' | 'neutral';

const TONE_CLASSES: Record<StatusTone, string> = {
  good: 'bg-[var(--green-soft)] text-[var(--green-dark)] border-[var(--green-border)]',
  warn: 'bg-[var(--amber-soft)] text-[var(--amber)] border-[var(--amber-border)]',
  danger: 'bg-[var(--red-soft)] text-[var(--danger)] border-[var(--red-soft-border)]',
  neutral: 'bg-[var(--surface)] text-[var(--muted)] border-[var(--line)]',
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>
      {label}
    </span>
  );
}
