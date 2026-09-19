'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatCard } from '@/components/admin/StatCard';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface ErrorRow {
  id: string;
  title: string;
  company: string;
  source: string;
  source_language: string | null;
  translated_at: string | null;
}

interface TranslationData {
  byStatus: Record<string, number>;
  byLanguage: Record<string, number>;
  errors: ErrorRow[];
}

export default function TranslationPage() {
  const [data, setData] = useState<TranslationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/translation');
      if (!res.ok) throw new Error(await describeFailure(res));
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;

  const columns: DataTableColumn<ErrorRow>[] = [
    { key: 'title', header: 'Title', render: (r) => r.title },
    { key: 'company', header: 'Company', render: (r) => r.company },
    { key: 'source', header: 'Source', render: (r) => <span className="tag">{r.source}</span> },
    { key: 'lang', header: 'Source language', render: (r) => r.source_language ?? '—' },
    { key: 'attempted', header: 'Last attempt', render: (r) => r.translated_at ? new Date(r.translated_at).toLocaleString() : '—' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Translation</h1>
        <p className="text-xs text-[var(--muted)]">Status of translatePendingOpportunities() across the active catalog.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="OK" value={data.byStatus['ok'] ?? 0} tone="good" />
        <StatCard label="Error" value={data.byStatus['error'] ?? 0} tone={data.byStatus['error'] > 0 ? 'danger' : 'good'} />
        <StatCard label="N/A (English)" value={data.byStatus['n/a'] ?? 0} />
        <StatCard label="Not yet processed" value={data.byStatus['not_yet_processed'] ?? 0} tone="warn" />
      </div>

      <section className="soft-card border border-[var(--line)] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Active jobs by source language</h2>
        {Object.keys(data.byLanguage).length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No language data yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {Object.entries(data.byLanguage).sort((a, b) => b[1] - a[1]).map(([lang, count]) => (
              <li key={lang} className="tag text-xs">{lang}: {count}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Recent translation errors</h2>
        {data.errors.length === 0 ? (
          <EmptyState label="No translation errors." />
        ) : (
          <div className="soft-card border border-[var(--line)]">
            <DataTable columns={columns} rows={data.errors} rowKey={(r) => r.id} />
          </div>
        )}
      </section>
    </div>
  );
}
