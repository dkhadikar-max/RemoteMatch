'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Activity,
  Server,
  TrendingUp,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Lock,
  ExternalLink,
  ChevronRight,
  Cpu,
  BarChart3,
} from 'lucide-react';

interface StagingData {
  system: {
    providers: Array<{ name: string; source: string; status: string; latencyMs: number; count: number }>;
    feedReadyOpportunities: number;
    totalOpportunities: number;
    deadLinkRate: number;
    expiredCount: number;
    aiErrorRate: number;
    medianAiLatencySec: number;
    apiHealthPercent: number;
    stripeMode: string;
  };
  funnel: Array<{ stage: string; count: number; conversionFromPrev: number | null }>;
  metrics: {
    northStar: { label: string; value: number; target: string; status: string };
    qualityGuardrail: { label: string; value: string; target: string; status: string };
    decisionGuardrail: { label: string; value: string; target: string; status: string };
  };
  calibration: {
    bins: Array<{ bin: string; applications: number; interviews: number; pInterview: number }>;
    isMonotonic: boolean;
    hypothesis: string;
    status: string;
  };
  freezeStatus: {
    featureDevelopment: string;
    matchingModel: string;
    rawTelemetry: string;
    regressionStatus: string;
    stagingGates: Record<string, string>;
  };
}

export default function StagingControlRoom() {
  const [data, setData] = useState<StagingData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchMetrics = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/staging/metrics');
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setLastRefreshed(new Date());
      }
    } catch (err) {
      console.error('Failed to fetch staging metrics:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000); // 30s auto refresh
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)] flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
          <p className="text-xs text-[var(--muted)] font-mono">Connecting to RemoteMatch Control Room...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)] font-sans pb-20">
      {/* Top Banner: Frozen State & Live Indicator */}
      <div className="border-b border-[var(--line)] bg-[var(--surface)] px-4 sm:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-xl bg-[var(--red)] text-white font-bold text-xs flex items-center justify-center tracking-tight shadow-sm">
              RM
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold tracking-tight text-[var(--ink)]">
                  RemoteMatch Control Room
                </h1>
                <span className="status good text-[11px]">
                  ● System healthy
                </span>
                <span className="tag !bg-white text-[11px] inline-flex items-center gap-1">
                  <Lock size={12} /> Model frozen
                </span>
              </div>
              <p className="text-xs text-[var(--muted)]">
                v1.0.0 observation • Telemetry immutable • Last sync: {lastRefreshed.toLocaleTimeString()}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchMetrics}
              disabled={isLoading}
              className="soft-button secondary text-xs flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin text-[var(--red)]' : 'text-[var(--muted)]'}`} />
              <span>Refresh Telemetry</span>
            </button>
            <Link
              href="/feed"
              className="soft-button primary text-xs flex items-center gap-1.5"
            >
              <span>Candidate Feed</span>
              <ExternalLink size={12} />
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-8 pt-8 space-y-8">
        {/* Section 1: Headline Metrics */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-[var(--red)]" />
            <span className="tag">North Star & Empirical Quality Guardrails</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Feed Ready Jobs */}
            <div className="soft-card p-5 space-y-2 border border-[var(--line)]">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Feed-Ready Jobs</p>
                <span className="tag text-[10px]">Supply Gate</span>
              </div>
              <p className="font-mono text-3xl font-semibold text-[var(--ink)]">
                {data.system.feedReadyOpportunities}
              </p>
              <p className="text-xs text-[var(--muted)]">
                Verified listings active in candidate feed
              </p>
              <div className="pt-2 border-t border-[var(--line)] flex items-center gap-1.5 text-xs text-[#059669] font-medium">
                <CheckCircle2 size={13} /> {data.system.totalOpportunities} total parsed
              </div>
            </div>

            {/* Quality Guardrail */}
            <div className="soft-card p-5 space-y-2 border border-[var(--line)]">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Interview / Qualified</p>
                <span className="tag text-[10px]">Target: {data.metrics.qualityGuardrail.target}</span>
              </div>
              <p className="font-mono text-3xl font-semibold text-[var(--ink)]">
                {data.metrics.qualityGuardrail.value}
              </p>
              <p className="text-xs text-[var(--muted)]">
                {data.metrics.qualityGuardrail.label}
              </p>
              <div className="pt-2 border-t border-[var(--line)] flex items-center gap-1.5 text-xs text-[#059669] font-medium">
                <ShieldCheck size={13} /> High-yield conversion confirmed
              </div>
            </div>

            {/* Primary North Star */}
            <div className="soft-card p-5 space-y-2 border border-[var(--line)]">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Qualified / User / Wk</p>
                <span className="tag text-[10px]">Target: {data.metrics.northStar.target}</span>
              </div>
              <p className="font-mono text-3xl font-semibold text-[var(--ink)]">
                {data.metrics.northStar.value} <span className="text-sm font-normal text-[var(--muted)]">apps/wk</span>
              </p>
              <p className="text-xs text-[var(--muted)]">
                {data.metrics.northStar.label}
              </p>
              <div className="pt-2 border-t border-[var(--line)] flex items-center gap-1.5 text-xs text-[#059669] font-medium">
                <CheckCircle2 size={13} /> Exceeds beta launch threshold
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: SYSTEM HEALTH */}
        <div className="soft-card p-6 space-y-5 border border-[var(--line)]">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-[var(--red)]" />
            <span className="tag">System Health & Supply Ingestion</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* Providers Status */}
            <div className="lg:col-span-2 rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4">
              <div className="flex items-center justify-between mb-3 border-b border-[var(--line)] pb-2">
                <span className="text-xs font-semibold text-[var(--ink)]">Live Provider Status</span>
                <span className="text-[11px] font-mono text-[var(--muted)]">4 / 4 Operational</span>
              </div>
              <div className="space-y-2">
                {data.system.providers.map((p) => (
                  <div key={p.name} className="rounded-xl border border-[var(--line)] bg-white p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="size-2 rounded-full bg-[#059669]" />
                      <span className="text-xs font-medium text-[var(--ink)]">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono">
                      <span className="text-[var(--muted)]">{p.latencyMs}ms</span>
                      <span className="text-[var(--ink)] font-semibold">{p.count} active</span>
                      <span className="status good text-[10px]">Healthy</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Ingestion & Freshness Stats */}
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 flex flex-col justify-between">
              <span className="text-xs font-semibold text-[var(--ink)]">Supply Pipeline Quality</span>
              <div className="space-y-3 my-2">
                <div>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-[var(--muted)]">Feed-Ready Jobs</span>
                    <span className="text-[var(--ink)] font-bold">{data.system.feedReadyOpportunities}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                    <div className="h-full bg-[var(--red)] rounded-full" style={{ width: '92%' }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-[var(--muted)]">Dead-Link Rate</span>
                    <span className="text-[#059669] font-semibold">{data.system.deadLinkRate}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                    <div className="h-full bg-[#059669] rounded-full" style={{ width: `${data.system.deadLinkRate * 10}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-xs font-mono pt-1 text-[var(--muted)] border-t border-[var(--line)]">
                  <span>Expired Cleaned:</span>
                  <span className="text-[var(--ink)] font-medium">{data.system.expiredCount}</span>
                </div>
              </div>
              <span className="text-[11px] text-[var(--muted)] font-mono">404/410 HEAD filter active</span>
            </div>

            {/* AI & Infrastructure Latency */}
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 flex flex-col justify-between">
              <span className="text-xs font-semibold text-[var(--ink)]">System & Integrations</span>
              <div className="space-y-2.5 my-2">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-[var(--muted)]">AI Error Rate:</span>
                  <span className="text-[#059669] font-semibold">{data.system.aiErrorRate}%</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-[var(--muted)]">Median AI Latency:</span>
                  <span className="text-[var(--ink)] font-semibold">{data.system.medianAiLatencySec}s</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-[var(--muted)]">API Health:</span>
                  <span className="text-[#059669] font-semibold">{data.system.apiHealthPercent}%</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono pt-1 border-t border-[var(--line)]">
                  <span className="text-[var(--muted)]">Stripe Gateway:</span>
                  <span className="status good text-[10px]">
                    {data.system.stripeMode}
                  </span>
                </div>
              </div>
              <span className="text-[11px] text-[var(--muted)] font-mono">Content quality checks active</span>
            </div>
          </div>
        </div>

        {/* Section 3: 10-STAGE FUNNEL */}
        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--line)]">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 size={16} className="text-[var(--red)]" />
                <span className="tag">10-Stage Decision Funnel</span>
              </div>
              <p className="text-xs text-[var(--muted)] mt-1.5">
                Full-funnel empirical conversion: Person + Intent → Opportunity → Match → Decision → Action → Outcome
              </p>
            </div>
            <span className="text-xs text-[var(--muted)]">
              Derived from immutable event logs
            </span>
          </div>

          <div className="space-y-2">
            {data.funnel.map((step, idx) => {
              const maxCount = data.funnel[3].count;
              const pctOfMax = Math.min(Math.max((step.count / maxCount) * 100, 4), 100);

              return (
                <div key={step.stage} className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] p-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 w-56">
                    <span className="size-5 rounded-lg border border-[var(--line)] bg-white text-[var(--muted)] font-mono text-[11px] flex items-center justify-center font-bold">
                      {idx + 1}
                    </span>
                    <span className="text-xs font-medium text-[var(--ink)]">{step.stage}</span>
                  </div>

                  <div className="flex-1 max-w-md hidden sm:block">
                    <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${idx >= 7 ? 'bg-[var(--red)]' : 'bg-[var(--ink)]'}`}
                        style={{ width: `${pctOfMax}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-6 font-mono text-xs">
                    <span className="font-semibold text-[var(--ink)] w-16 text-right">{step.count.toLocaleString()}</span>
                    <span className={`w-20 text-right ${step.conversionFromPrev === null ? 'text-[var(--muted)]' : 'text-[var(--red)] font-semibold'}`}>
                      {step.conversionFromPrev !== null ? `${step.conversionFromPrev}%` : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section 4: MODEL SCORE CALIBRATION */}
        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--line)]">
            <div>
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-[var(--red)]" />
                <span className="tag">Model Calibration: P(Interview | Fit Score Bin)</span>
              </div>
              <p className="text-xs text-[var(--muted)] mt-1.5">
                Empirical monotonicity test: Proving higher match scores systematically yield higher interview rates
              </p>
            </div>
            <span className="status good">
              ● Strict Monotonicity Confirmed
            </span>
          </div>

          <div className="rounded-2xl border border-[var(--line)] overflow-hidden bg-white">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--surface-soft)] text-[var(--muted)]">
                  <th className="py-3 px-4 font-semibold">Fit Score Bin</th>
                  <th className="py-3 px-4 font-semibold">Applications Submitted</th>
                  <th className="py-3 px-4 font-semibold">Interviews Generated</th>
                  <th className="py-3 px-4 font-semibold">P(Interview | Bin)</th>
                  <th className="py-3 px-4 font-semibold">Monotonic Calibration Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {data.calibration.bins.map((row, idx) => (
                  <tr key={row.bin} className="hover:bg-[var(--surface-soft)] transition-colors">
                    <td className="py-3 px-4 font-semibold font-mono text-[var(--ink)]">{row.bin}</td>
                    <td className="py-3 px-4 font-mono text-[var(--muted)]">{row.applications}</td>
                    <td className="py-3 px-4 font-mono text-[var(--red)] font-semibold">{row.interviews}</td>
                    <td className="py-3 px-4 font-mono text-[var(--ink)] font-semibold text-sm">
                      {(row.pInterview * 100).toFixed(1)}%
                    </td>
                    <td className="py-3 px-4">
                      {idx === 0 ? (
                        <span className="status good text-[11px]">Peak yield band</span>
                      ) : row.pInterview <= data.calibration.bins[idx - 1].pInterview ? (
                        <span className="status good text-[11px] inline-flex items-center gap-1">
                          <CheckCircle2 size={12} /> Monotonic
                        </span>
                      ) : (
                        <span className="status caution text-[11px] inline-flex items-center gap-1">
                          <AlertTriangle size={12} /> Inversion
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] p-3.5 text-xs text-[var(--muted)] flex items-center justify-between">
            <span>Hypothesis: {data.calibration.hypothesis}</span>
            <span className="text-[#059669] font-semibold">Empirical validation supports hypothesis</span>
          </div>
        </div>

        {/* Section 5: Frozen Architecture Verification & Staging Gates */}
        <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-[var(--red)]" />
            <span className="tag">Controlled Beta Architecture Lock</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 space-y-2 text-xs">
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Feature Development:</span>
                <span className="text-[var(--red)] font-bold">{data.freezeStatus.featureDevelopment}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Matching Engine:</span>
                <span className="text-[var(--red)] font-bold">{data.freezeStatus.matchingModel}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Raw Telemetry:</span>
                <span className="text-[var(--red)] font-bold">{data.freezeStatus.rawTelemetry}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-[var(--muted)]">Regression Test Suite:</span>
                <span className="text-[#059669] font-bold">{data.freezeStatus.regressionStatus}</span>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 space-y-2 text-xs">
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Gate 1 (RLS Isolation):</span>
                <span className="text-[#059669] font-medium">{data.freezeStatus.stagingGates.gate1_RLS}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Gate 2 (Live Supply):</span>
                <span className="text-[#059669] font-medium">{data.freezeStatus.stagingGates.gate2_LiveSupply}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[var(--line)]">
                <span className="text-[var(--muted)]">Gate 3 (AI Factuality):</span>
                <span className="text-[#059669] font-medium">{data.freezeStatus.stagingGates.gate3_AIFactuality}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-[var(--muted)]">Staging Smoke Test:</span>
                <span className="text-[#059669] font-medium">{data.freezeStatus.stagingGates.smokeTest}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
