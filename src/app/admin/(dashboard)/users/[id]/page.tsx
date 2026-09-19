'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { StatCard } from '@/components/admin/StatCard';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface UserDetail {
  user: {
    id: string;
    email: string | null;
    full_name: string | null;
    plan_tier: string;
    created_at: string;
    onboarding_completed_at: string | null;
    usage_date: string;
  };
  applicationsByStatus: Record<string, number>;
  swipesByAction: Record<string, number>;
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;

  const totalSwipes = Object.values(data.swipesByAction).reduce((a, b) => a + b, 0);
  const totalApplications = Object.values(data.applicationsByStatus).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <Link href="/admin/users" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)]">
        <ArrowLeft size={13} /> Back to Users
      </Link>

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[var(--ink)]">{data.user.email ?? data.user.id}</h1>
          {data.user.full_name && <p className="text-xs text-[var(--muted)]">{data.user.full_name}</p>}
        </div>
        <StatusBadge label={data.user.plan_tier} tone={data.user.plan_tier === 'pro' ? 'good' : 'neutral'} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total swipes" value={totalSwipes} />
        <StatCard label="Total applications" value={totalApplications} />
        <StatCard label="Onboarded" value={data.user.onboarding_completed_at ? 'Yes' : 'No'} />
        <StatCard label="Signed up" value={new Date(data.user.created_at).toLocaleDateString()} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Applications by status</h2>
          {Object.keys(data.applicationsByStatus).length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No applications.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {Object.entries(data.applicationsByStatus).map(([status, count]) => (
                <li key={status} className="flex justify-between"><span>{status}</span><span className="tabular-nums text-[var(--muted)]">{count}</span></li>
              ))}
            </ul>
          )}
        </section>
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Swipes by action</h2>
          {Object.keys(data.swipesByAction).length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No swipes.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {Object.entries(data.swipesByAction).map(([action, count]) => (
                <li key={action} className="flex justify-between"><span>{action}</span><span className="tabular-nums text-[var(--muted)]">{count}</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
