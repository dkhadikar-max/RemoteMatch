import Link from 'next/link';
import { INCOMPLETE_PROFILE_COPY } from '@/lib/profile/usable';

/**
 * Shown above the feed when the signed-in user has no usable matching profile (no skills and no target roles).
 * The jobs below are then listed WITHOUT fit percentages — the feed must never imply it is personalized when it is not.
 */
export function IncompleteProfileNotice() {
  return (
    <div
      role="status"
      className="w-full max-w-[440px] md:max-w-[560px] mb-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3.5 shadow-sm"
    >
      <p className="text-sm font-bold text-[var(--ink)]">{INCOMPLETE_PROFILE_COPY.title}</p>
      <p className="text-xs text-[var(--muted)] mt-1">{INCOMPLETE_PROFILE_COPY.body}</p>
      <Link
        href={INCOMPLETE_PROFILE_COPY.href}
        className="mt-3 inline-flex items-center rounded-xl bg-[var(--red)] px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90 min-h-[40px]"
      >
        {INCOMPLETE_PROFILE_COPY.cta}
      </Link>
    </div>
  );
}
