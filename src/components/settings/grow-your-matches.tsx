'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles, Plus } from 'lucide-react';
import type { SkillOpportunity } from '@/lib/resume/skill-opportunities';

interface Props {
  /** Called after a skill is added, so the parent can refresh the skill list. */
  onSkillAdded?: () => void;
}

type RowState = 'idle' | 'adding' | 'added' | 'dismissing' | 'dismissed';

/**
 * "Grow your matches" (ticket I) — skills most requested across the user's
 * relevant jobs that they haven't listed. It NEVER says "add X" or "we found X
 * in your résumé"; it only ever asks "Do you have X experience?" and adds a
 * skill on an explicit "Yes".
 */
export function GrowYourMatches({ onSkillAdded }: Props) {
  const [items, setItems] = useState<SkillOpportunity[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/resume/opportunities', { cache: 'no-store' });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data.opportunities) ? data.opportunities : []);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setRow = (key: string, s: RowState) => setRowState((prev) => ({ ...prev, [key]: s }));

  const handleConfirm = async (item: SkillOpportunity) => {
    setRow(item.skillKey, 'adding');
    try {
      const res = await fetch('/api/profile/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: item.skill }),
      });
      if (!res.ok) {
        setRow(item.skillKey, 'idle');
        return;
      }
      setRow(item.skillKey, 'added');
      onSkillAdded?.();
    } catch {
      setRow(item.skillKey, 'idle');
    }
  };

  const handleDismiss = async (item: SkillOpportunity) => {
    setRow(item.skillKey, 'dismissing');
    try {
      const res = await fetch('/api/profile/skills/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillKey: item.skillKey }),
      });
      setRow(item.skillKey, res.ok ? 'dismissed' : 'idle');
    } catch {
      setRow(item.skillKey, 'idle');
    }
  };

  if (loadFailed) return null;
  if (items === null) {
    return (
      <div className="soft-card p-6 sm:p-8 border border-[var(--line)]">
        <div className="h-4 w-40 rounded bg-[var(--surface-soft)] animate-pulse" />
      </div>
    );
  }

  const visible = items.filter((i) => {
    const s = rowState[i.skillKey];
    return s !== 'added';
  });

  return (
    <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
      <div>
        <h2 className="text-lg font-bold text-[var(--ink)] flex items-center gap-2">
          <Sparkles size={17} className="text-[var(--red)]" />
          Grow your matches
        </h2>
        <p className="text-xs text-[var(--muted)] mt-1">Based on the roles you&rsquo;re targeting.</p>
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Your profile already covers the skills most requested for your target roles. Set or refine
          your target roles in onboarding to see new suggestions.
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => {
            const s = rowState[item.skillKey] ?? 'idle';
            return (
              <li
                key={item.skillKey}
                className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-2"
              >
                {s === 'dismissed' ? (
                  <p className="text-xs text-[var(--muted)] leading-relaxed">
                    <span className="font-semibold text-[var(--ink)]">{item.skill}</span> could increase
                    your opportunities, but it isn&rsquo;t currently part of your profile.
                  </p>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold text-sm text-[var(--ink)]">{item.skill}</span>
                      <span className="text-[11px] text-[var(--muted)] shrink-0">
                        Found in {item.jobCount} relevant {item.jobCount === 1 ? 'job' : 'jobs'}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--muted)]">
                      Do you have {item.skill} experience?
                    </p>
                    <div className="flex items-center gap-2 pt-0.5">
                      <button
                        type="button"
                        disabled={s === 'adding' || s === 'dismissing'}
                        onClick={() => handleConfirm(item)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-60 text-white text-xs font-semibold px-3.5 py-2 transition-colors shadow-sm min-h-[38px]"
                      >
                        <Plus size={13} />
                        <span>{s === 'adding' ? 'Adding…' : 'Yes, add it'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={s === 'adding' || s === 'dismissing'}
                        onClick={() => handleDismiss(item)}
                        className="inline-flex items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] disabled:opacity-60 text-[var(--muted)] hover:text-[var(--ink)] text-xs font-semibold px-3.5 py-2 transition-colors min-h-[38px]"
                      >
                        I don&rsquo;t have this
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
