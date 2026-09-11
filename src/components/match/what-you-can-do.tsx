'use client';

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ActionableSkillGap } from '@/lib/match/actionable-skill-gaps';

type RowState = 'idle' | 'adding' | 'added' | 'dismissing' | 'dismissed';

interface Props {
  gaps: ActionableSkillGap[];
  /** Fired once a row resolves (added OR dismissed) so the parent can drop
   *  it from "What may be missing" too — one shared source of truth, not a
   *  second list. */
  onResolved: (skillKey: string) => void;
}

/**
 * "What you can do" (ticket L, L2/L3). Reuses ticket I's exact confirm-before
 * -add contract and exact two write endpoints — never a new skills/dismissal
 * mechanism. Never asserts the user has a skill; only ever asks.
 *
 * Deliberate limitation (accepted, per L review): this does not fetch the
 * user's global dismissal set, so a skill dismissed earlier in Settings →
 * Grow your matches can still appear here. It is the same underlying fact
 * about the same user, not a duplicate mechanism — the write path is
 * identical either way.
 */
export function WhatYouCanDo({ gaps, onResolved }: Props) {
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const setRow = (key: string, s: RowState) => setRowState((prev) => ({ ...prev, [key]: s }));

  const handleConfirm = async (gap: ActionableSkillGap) => {
    setRow(gap.skillKey, 'adding');
    try {
      const res = await fetch('/api/profile/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName: gap.skill }),
      });
      if (!res.ok) {
        setRow(gap.skillKey, 'idle');
        return;
      }
      setRow(gap.skillKey, 'added');
      onResolved(gap.skillKey);
    } catch {
      setRow(gap.skillKey, 'idle');
    }
  };

  const handleDismiss = async (gap: ActionableSkillGap) => {
    setRow(gap.skillKey, 'dismissing');
    try {
      const res = await fetch('/api/profile/skills/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillKey: gap.skillKey }),
      });
      if (!res.ok) {
        setRow(gap.skillKey, 'idle');
        return;
      }
      setRow(gap.skillKey, 'dismissed');
      onResolved(gap.skillKey);
    } catch {
      setRow(gap.skillKey, 'idle');
    }
  };

  // "Added" rows leave the panel entirely (same as ticket I's Grow Your
  // Matches) — the user's own skill list is now the record of that. A
  // "dismissed" row stays visible with the same reassurance copy ticket I
  // uses, rather than disappearing, so the user sees their answer was heard.
  const visible = gaps.filter((g) => rowState[g.skillKey] !== 'added');

  if (visible.length === 0) return null;

  return (
    <div className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-5 space-y-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-bold text-[var(--ink)] uppercase tracking-wider pb-2 border-b border-[var(--line)]">
        <span>What you can do</span>
      </div>
      <ul className="space-y-3">
        {visible.map((gap) => {
          const s = rowState[gap.skillKey] ?? 'idle';
          return (
            <li
              key={gap.skillKey}
              className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-3.5 space-y-2"
            >
              {s === 'dismissed' ? (
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  <span className="font-semibold text-[var(--ink)]">{gap.skill}</span> could increase
                  your opportunities, but it isn&rsquo;t currently part of your profile.
                </p>
              ) : (
                <>
                  <p className="text-xs font-medium text-[var(--ink)]">
                    Do you have {gap.skill} experience?
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={s === 'adding' || s === 'dismissing'}
                      onClick={() => handleConfirm(gap)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-60 text-white text-xs font-semibold px-3.5 py-2 transition-colors shadow-sm min-h-[38px]"
                    >
                      <Plus size={13} />
                      <span>{s === 'adding' ? 'Adding…' : 'Yes, add it'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={s === 'adding' || s === 'dismissing'}
                      onClick={() => handleDismiss(gap)}
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
    </div>
  );
}
