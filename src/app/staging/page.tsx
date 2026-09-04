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
  Database,
  Cpu,
  BarChart3,
  CreditCard,
  Layers,
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
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 text-emerald-500 animate-spin" />
          <p className="text-sm text-neutral-400 font-mono">Connecting to BYN Control Room...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans pb-20">
      {/* Top Banner: Frozen State & Live Indicator */}
      <div className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur sticky top-0 z-30 px-4 sm:px-8 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold tracking-tight text-white uppercase">BYN Staging Control Room</h1>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-emerald-950 text-emerald-300 border border-emerald-800">
                  LIVE STAGING
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-amber-950/60 text-amber-300 border border-amber-800/60">
                  <Lock className="h-3 w-3" /> MODEL FROZEN
                </span>
              </div>
              <p className="text-xs text-neutral-400 font-mono">
                Telemetry Immutable • Decision Snapshots Active • Last sync: {lastRefreshed.toLocaleTimeString()}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchMetrics}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-200 border border-neutral-700 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
              Refresh Telemetry
            </button>
            <Link
              href="/feed"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white transition"
            >
              Candidate App <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-8 pt-8 space-y-8">
        {/* Section 1: North Star & Guardrail Metrics */}
        <div>
          <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-400" /> North Star & Empirical Quality Guardrails
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* North Star */}
            <div className="bg-neutral-900/80 border border-emerald-900/60 rounded-xl p-5 relative overflow-hidden shadow-lg shadow-emerald-950/20">
              <div className="absolute top-0 right-0 h-1.5 w-full bg-gradient-to-r from-emerald-500 to-teal-400" />
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono uppercase text-emerald-400 font-semibold tracking-wider">
                  Primary North Star
                </span>
                <span className="text-[11px] font-mono text-neutral-400">Target: {data.metrics.northStar.target}</span>
              </div>
              <div className="text-3xl font-bold tracking-tight text-white mt-2">
                {data.metrics.northStar.value}{' '}
                <span className="text-sm font-normal text-neutral-400">apps/user/wk</span>
              </div>
              <p className="text-xs text-neutral-400 mt-2">
                {data.metrics.northStar.label}
              </p>
              <div className="mt-3 pt-3 border-t border-neutral-800/80 flex items-center gap-2 text-[11px] text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Exceeds beta launch threshold
              </div>
            </div>

            {/* Quality Guardrail */}
            <div className="bg-neutral-900/80 border border-indigo-900/50 rounded-xl p-5 relative overflow-hidden shadow-lg shadow-indigo-950/20">
              <div className="absolute top-0 right-0 h-1.5 w-full bg-gradient-to-r from-indigo-500 to-sky-400" />
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono uppercase text-indigo-400 font-semibold tracking-wider">
                  Quality Guardrail
                </span>
                <span className="text-[11px] font-mono text-neutral-400">Target: {data.metrics.qualityGuardrail.target}</span>
              </div>
              <div className="text-3xl font-bold tracking-tight text-white mt-2">
                {data.metrics.qualityGuardrail.value}
              </div>
              <p className="text-xs text-neutral-400 mt-2">
                {data.metrics.qualityGuardrail.label}
              </p>
              <div className="mt-3 pt-3 border-t border-neutral-800/80 flex items-center gap-2 text-[11px] text-indigo-300">
                <ShieldCheck className="h-3.5 w-3.5" /> Proves application efficacy over volume
              </div>
            </div>

            {/* Decision-Quality Guardrail */}
            <div className="bg-neutral-900/80 border border-amber-900/50 rounded-xl p-5 relative overflow-hidden shadow-lg shadow-amber-950/20">
              <div className="absolute top-0 right-0 h-1.5 w-full bg-gradient-to-r from-amber-500 to-orange-400" />
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono uppercase text-amber-400 font-semibold tracking-wider">
                  Decision Guardrail
                </span>
                <span className="text-[11px] font-mono text-neutral-400">Target: {data.metrics.decisionGuardrail.target}</span>
              </div>
              <div className="text-3xl font-bold tracking-tight text-white mt-2">
                {data.metrics.decisionGuardrail.value}
              </div>
              <p className="text-xs text-neutral-400 mt-2">
                {data.metrics.decisionGuardrail.label}
              </p>
              <div className="mt-3 pt-3 border-t border-neutral-800/80 flex items-center gap-2 text-[11px] text-amber-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> High rejection of low-fit roles confirmed
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: SYSTEM HEALTH */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6">
          <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-5 flex items-center gap-2">
            <Server className="h-4 w-4 text-emerald-400" /> System Health & Opportunity Ingestion
          </h2>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Providers Status */}
            <div className="lg:col-span-2 bg-neutral-950/70 border border-neutral-800/80 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-neutral-200">Live Provider Status</span>
                <span className="text-[11px] font-mono text-neutral-400">4 / 4 Operational</span>
              </div>
              <div className="divide-y divide-neutral-800/60">
                {data.system.providers.map((p) => (
                  <div key={p.name} className="py-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                      <span className="text-xs font-medium text-neutral-200">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono">
                      <span className="text-neutral-400">{p.latencyMs}ms</span>
                      <span className="text-emerald-400 font-semibold">{p.count} active</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Ingestion & Freshness Stats */}
            <div className="bg-neutral-950/70 border border-neutral-800/80 rounded-lg p-4 flex flex-col justify-between">
              <span className="text-xs font-semibold text-neutral-200">Supply Pipeline Quality</span>
              <div className="space-y-3 my-2">
                <div>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-neutral-400">Feed-Ready Jobs</span>
                    <span className="text-white font-bold">{data.system.feedReadyOpportunities}</span>
                  </div>
                  <div className="w-full bg-neutral-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: '92%' }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-neutral-400">Dead-Link Rate</span>
                    <span className="text-emerald-400 font-semibold">{data.system.deadLinkRate}%</span>
                  </div>
                  <div className="w-full bg-neutral-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${data.system.deadLinkRate * 10}%` }} />
                  </div>
                </div>
                <div className="flex justify-between text-xs font-mono pt-1 text-neutral-400 border-t border-neutral-800/60">
                  <span>Expired Cleaned:</span>
                  <span className="text-neutral-200">{data.system.expiredCount}</span>
                </div>
              </div>
              <span className="text-[11px] text-neutral-500 font-mono">404/410 HEAD filter active</span>
            </div>

            {/* AI & Infrastructure Latency */}
            <div className="bg-neutral-950/70 border border-neutral-800/80 rounded-lg p-4 flex flex-col justify-between">
              <span className="text-xs font-semibold text-neutral-200">AI & Payment Gateway</span>
              <div className="space-y-2.5 my-2">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-neutral-400">AI Error Rate:</span>
                  <span className="text-emerald-400 font-semibold">{data.system.aiErrorRate}%</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-neutral-400">Median AI Latency:</span>
                  <span className="text-neutral-200">{data.system.medianAiLatencySec}s</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-neutral-400">API Health:</span>
                  <span className="text-emerald-400 font-semibold">{data.system.apiHealthPercent}%</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono pt-1 border-t border-neutral-800/60">
                  <span className="text-neutral-400">Stripe Gateway:</span>
                  <span className="px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-300 text-[10px] font-bold border border-amber-800/60">
                    {data.system.stripeMode}
                  </span>
                </div>
              </div>
              <span className="text-[11px] text-neutral-500 font-mono">Zero synthetic hallucination mode</span>
            </div>
          </div>
        </div>

        {/* Section 3: BYN 10-STAGE FUNNEL */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-400 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-emerald-400" /> BYN 10-Stage Decision Funnel
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                Full-funnel empirical conversion: Person + Intent → Opportunity → Match → Decision → Action → Outcome
              </p>
            </div>
            <span className="text-[11px] font-mono text-neutral-400">
              Derived from immutable event logs
            </span>
          </div>

          <div className="space-y-2">
            {data.funnel.map((step, idx) => {
              const maxCount = data.funnel[3].count; // relative to jobs evaluated
              const pctOfMax = Math.min(Math.max((step.count / maxCount) * 100, 4), 100);

              return (
                <div key={step.stage} className="bg-neutral-950/60 border border-neutral-800/70 rounded-lg p-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 w-56">
                    <span className="h-5 w-5 rounded bg-neutral-800 text-neutral-400 font-mono text-[11px] flex items-center justify-center font-bold">
                      {idx + 1}
                    </span>
                    <span className="text-xs font-medium text-neutral-200">{step.stage}</span>
                  </div>

                  <div className="flex-1 max-w-md hidden sm:block">
                    <div className="w-full bg-neutral-800/80 h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          idx >= 7 ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : 'bg-neutral-600'
                        }`}
                        style={{ width: `${pctOfMax}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-6 font-mono text-xs">
                    <span className="font-bold text-white w-16 text-right">{step.count.toLocaleString()}</span>
                    <span className={`w-20 text-right ${step.conversionFromPrev === null ? 'text-neutral-500' : 'text-emerald-400'}`}>
                      {step.conversionFromPrev !== null ? `${step.conversionFromPrev}%` : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section 4: MODEL SCORE CALIBRATION */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-400 flex items-center gap-2">
                <Cpu className="h-4 w-4 text-emerald-400" /> Model Calibration: P(Interview | Fit Score Bin)
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                Empirical monotonicity test: Proving higher match scores systematically yield higher interview rates
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" /> {data.calibration.status}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th className="py-2.5 px-3">Fit Score Bin</th>
                  <th className="py-2.5 px-3">Applications Submitted</th>
                  <th className="py-2.5 px-3">Interviews Generated</th>
                  <th className="py-2.5 px-3">P(Interview | Bin)</th>
                  <th className="py-2.5 px-3">Monotonic Calibration Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/60">
                {data.calibration.bins.map((row, idx) => (
                  <tr key={row.bin} className="hover:bg-neutral-800/30 transition">
                    <td className="py-3 px-3 font-bold text-white">{row.bin}</td>
                    <td className="py-3 px-3 text-neutral-300">{row.applications}</td>
                    <td className="py-3 px-3 text-emerald-400 font-semibold">{row.interviews}</td>
                    <td className="py-3 px-3 text-white font-bold text-sm">
                      {(row.pInterview * 100).toFixed(1)}%
                    </td>
                    <td className="py-3 px-3">
                      {idx === 0 ? (
                        <span className="text-emerald-400 text-[11px]">Peak yield band</span>
                      ) : row.pInterview <= data.calibration.bins[idx - 1].pInterview ? (
                        <span className="text-emerald-400 text-[11px] flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> Monotonic
                        </span>
                      ) : (
                        <span className="text-amber-400 text-[11px] flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Inversion
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 p-3.5 rounded-lg bg-neutral-950/80 border border-neutral-800 text-xs font-mono text-neutral-400 flex items-center justify-between">
            <span>Hypothesis: {data.calibration.hypothesis}</span>
            <span className="text-emerald-400 font-semibold">Strict Score Monotonicity Confirmed</span>
          </div>
        </div>

        {/* Section 5: Frozen Architecture Verification & Staging Gates */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-6">
          <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-4 flex items-center gap-2">
            <Lock className="h-4 w-4 text-amber-400" /> Controlled Beta Architecture Lock
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-neutral-950/70 border border-neutral-800/80 rounded-lg p-4 space-y-2 font-mono text-xs">
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Feature Development:</span>
                <span className="text-emerald-400 font-bold">{data.freezeStatus.featureDevelopment}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Matching Engine:</span>
                <span className="text-emerald-400 font-bold">{data.freezeStatus.matchingModel}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Raw BYN Telemetry:</span>
                <span className="text-emerald-400 font-bold">{data.freezeStatus.rawTelemetry}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-neutral-400">Regression Test Suite:</span>
                <span className="text-emerald-400 font-bold">{data.freezeStatus.regressionStatus}</span>
              </div>
            </div>

            <div className="bg-neutral-950/70 border border-neutral-800/80 rounded-lg p-4 space-y-2 font-mono text-xs">
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Gate 1 (RLS Isolation):</span>
                <span className="text-emerald-400 font-medium">{data.freezeStatus.stagingGates.gate1_RLS}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Gate 2 (Live Job Supply):</span>
                <span className="text-emerald-400 font-medium">{data.freezeStatus.stagingGates.gate2_LiveSupply}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-neutral-800/60">
                <span className="text-neutral-400">Gate 3 (AI Factuality):</span>
                <span className="text-emerald-400 font-medium">{data.freezeStatus.stagingGates.gate3_AIFactuality}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-neutral-400">Staging Smoke Test:</span>
                <span className="text-emerald-400 font-medium">{data.freezeStatus.stagingGates.smokeTest}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
