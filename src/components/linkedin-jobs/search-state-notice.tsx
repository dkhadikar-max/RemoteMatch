'use client';

import React from 'react';
import { AlertTriangle, Info, RotateCcw, Loader2 } from 'lucide-react';
import { SEARCH_NOTICE_COPY, type SearchViewState } from '@/lib/linkedin-jobs/search-view-state';

/**
 * What the LinkedIn search tab shows INSTEAD of a result list: a failed
 * search, an unconnected vendor, or a legitimately empty result. Copy and
 * the retry decision live in src/lib/linkedin-jobs/search-view-state.ts.
 */
interface SearchStateNoticeProps {
  state: SearchViewState;
  onRetry: () => void;
  isRetrying?: boolean;
}

export function SearchStateNotice({ state, onRetry, isRetrying = false }: SearchStateNoticeProps) {
  // 'results' renders the list and 'limit_reached' opens the upgrade modal;
  // neither is a notice.
  if (state.kind === 'results' || state.kind === 'limit_reached') return null;
  const copy = SEARCH_NOTICE_COPY[state.kind];
  return (
    <div
      role={copy.isError ? 'alert' : 'status'}
      className={`rounded-2xl border px-4 py-3.5 space-y-2 ${
        copy.isError ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className={copy.isError ? 'text-red-700 mt-0.5' : 'text-amber-700 mt-0.5'}>
          {copy.isError ? <AlertTriangle size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
        </span>
        <div className="space-y-1">
          <p className={`text-sm font-semibold ${copy.isError ? 'text-red-800' : 'text-amber-900'}`}>{copy.title}</p>
          <p className={`text-sm leading-relaxed ${copy.isError ? 'text-red-800' : 'text-amber-900'}`}>{copy.body}</p>
          {state.quotaNote && <p className="text-xs text-red-700">{state.quotaNote}</p>}
        </div>
      </div>
      {copy.canRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-800 hover:bg-red-100 transition-colors disabled:opacity-60"
        >
          {isRetrying ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
          <span>Try again</span>
        </button>
      )}
    </div>
  );
}
