/**
 * Supply Discovery gate C5 — priority signal (docs/c5-implementation-plan.md §2a)
 * ==============================================================================
 * Demand-INFORMED source prioritization, not demand-AUTOMATED discovery.
 * Every function here is read-only against data that already exists in
 * production — no new data collection, no writes.
 *
 * Explicitly does NOT read from or write to C2's `demand_gap_snapshots` or
 * any other gated demand artifact. That verdict (DATASET INSUFFICIENT, D3
 * deferred) stands exactly as it is — this module has no path to it at all.
 *
 * Output is a RANKED LIST OF CANDIDATES FOR HUMAN REVIEW, never an
 * auto-approval. A candidate is always a company already observed in the
 * existing catalog (an aggregator listing, typically) — this promotes an
 * already-known company to a more direct acquisition channel, it never
 * discovers a previously-unknown one. True discovery of unknown companies
 * stays C6's job, untouched by this module.
 */
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export interface CatalogPrioritySignal {
  /** skill (as stored in required_skills/tags) -> count of active rows carrying it */
  skillFrequency: Record<string, number>;
  /** company -> count of active rows for that company, across every source */
  companyFrequency: Record<string, number>;
  /** company -> the distinct skills THAT company's own postings actually
   *  carry (not the catalog-wide top skills) — needed so a reviewer sees
   *  genuinely company-specific relevance, not a repeated generic list. */
  companySkills: Record<string, Set<string>>;
  /** company -> the distinct remote_type values THAT company's own
   *  postings carry. */
  companyRemoteTypes: Record<string, Set<string>>;
  /** remote_type -> count of active rows — a geo-coverage signal, not a claim */
  remoteTypeDistribution: Record<string, number>;
  totalActiveRows: number;
}

/** Read-only aggregation over the real, already-ingested catalog. No new
 *  collection, no external calls — every input already exists. */
export async function computeCatalogPrioritySignal(): Promise<CatalogPrioritySignal> {
  const admin = getSupabaseAdminClient();
  const signal: CatalogPrioritySignal = {
    skillFrequency: {},
    companyFrequency: {},
    companySkills: {},
    companyRemoteTypes: {},
    remoteTypeDistribution: {},
    totalActiveRows: 0,
  };
  if (!admin) return signal;

  const { data } = await admin
    .from('opportunities')
    .select('company, required_skills, remote_type')
    .eq('status', 'active');

  const rows = data ?? [];
  signal.totalActiveRows = rows.length;

  for (const row of rows) {
    const company = (row.company || '').trim();
    const remoteType = row.remote_type || 'unknown';
    signal.remoteTypeDistribution[remoteType] = (signal.remoteTypeDistribution[remoteType] || 0) + 1;

    if (company) {
      signal.companyFrequency[company] = (signal.companyFrequency[company] || 0) + 1;
      if (!signal.companySkills[company]) signal.companySkills[company] = new Set();
      if (!signal.companyRemoteTypes[company]) signal.companyRemoteTypes[company] = new Set();
      signal.companyRemoteTypes[company].add(remoteType);
    }

    for (const raw of row.required_skills || []) {
      const skill = (raw || '').trim();
      if (!skill) continue;
      signal.skillFrequency[skill] = (signal.skillFrequency[skill] || 0) + 1;
      if (company) signal.companySkills[company]?.add(skill);
    }
  }

  return signal;
}

/**
 * Deliberately typed to make misuse hard: `weakSignal: true` is load-bearing
 * documentation, not decoration. This is raw counts from real user data,
 * never a normalized/statistically-validated score, and must never be
 * presented anywhere (UI, report, log) as a demand statistic. It exists
 * only as a low-weight secondary input to rankPriorityCandidates() below.
 */
export interface WeakUserBiasSignal {
  weakSignal: true;
  rawSkillCounts: Record<string, number>;
  rawTargetRoleCounts: Record<string, number>;
}

export async function computeWeakUserBias(): Promise<WeakUserBiasSignal> {
  const admin = getSupabaseAdminClient();
  const result: WeakUserBiasSignal = { weakSignal: true, rawSkillCounts: {}, rawTargetRoleCounts: {} };
  if (!admin) return result;

  const { data: skillRows } = await admin.from('profile_skills').select('skill_name');
  for (const row of skillRows ?? []) {
    const skill = (row.skill_name || '').trim();
    if (!skill) continue;
    result.rawSkillCounts[skill] = (result.rawSkillCounts[skill] || 0) + 1;
  }

  const { data: intentRows } = await admin.from('profile_intents').select('target_roles');
  for (const row of intentRows ?? []) {
    for (const raw of row.target_roles || []) {
      const role = (raw || '').trim();
      if (!role) continue;
      result.rawTargetRoleCounts[role] = (result.rawTargetRoleCounts[role] || 0) + 1;
    }
  }

  return result;
}

export interface PriorityCandidate {
  company: string;
  /** How many active catalog rows already exist for this company, across
   *  every source — the primary, real, market-supply signal. */
  catalogPostingFrequency: number;
  /** Skills this company's postings carry, ranked by how often those
   *  skills recur across the whole catalog (not just this company) — the
   *  cluster-relevance signal. */
  matchedHighFrequencySkills: string[];
  /** Low-weight secondary nudge from real (but statistically unvalidated)
   *  user data — informational only, never the primary sort key. */
  weakUserBiasScore: number;
  /** remote_type values observed for this company's existing postings —
   *  surfaced so a human reviewer can see geo coverage at a glance. */
  observedRemoteTypes: string[];
}

/**
 * Combines both signals into a ranked list of REAL, ALREADY-CATALOGED
 * companies worth considering for a direct career-page connection.
 * Every candidate.company value is drawn from computeCatalogPrioritySignal()
 * — this function can never surface a company that isn't already present
 * in real ingested data. Sort is primarily by catalogPostingFrequency
 * (repeat-hiring signal); weakUserBiasScore only breaks ties among
 * otherwise-similar candidates, never overrides the primary signal.
 */
export async function rankPriorityCandidates(
  catalogSignal: CatalogPrioritySignal,
  userBias: WeakUserBiasSignal,
  opts?: { minPostings?: number; limit?: number }
): Promise<PriorityCandidate[]> {
  const minPostings = opts?.minPostings ?? 2;
  const limit = opts?.limit ?? 25;

  const topSkills = new Set(
    Object.entries(catalogSignal.skillFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([skill]) => skill.toLowerCase())
  );

  const candidates: PriorityCandidate[] = Object.entries(catalogSignal.companyFrequency)
    .filter(([, count]) => count >= minPostings)
    .map(([company, catalogPostingFrequency]) => {
      // Weak bias is a per-SKILL/per-ROLE signal, not per-company — sum the
      // bias for whichever skills THIS company's own postings actually
      // carry, rather than looking up the company name in a skill map.
      const companyOwnSkills = Array.from(catalogSignal.companySkills[company] ?? new Set<string>());
      let weakUserBiasScore = 0;
      for (const skill of companyOwnSkills) {
        weakUserBiasScore += userBias.rawSkillCounts[skill] ?? 0;
      }

      const matchedHighFrequencySkills = companyOwnSkills.filter((s) =>
        topSkills.has(s.toLowerCase())
      );

      return {
        company,
        catalogPostingFrequency,
        matchedHighFrequencySkills,
        weakUserBiasScore,
        observedRemoteTypes: Array.from(catalogSignal.companyRemoteTypes[company] ?? []),
      };
    });

  candidates.sort((a, b) => {
    if (b.catalogPostingFrequency !== a.catalogPostingFrequency) {
      return b.catalogPostingFrequency - a.catalogPostingFrequency;
    }
    return b.weakUserBiasScore - a.weakUserBiasScore; // tie-break only
  });

  return candidates.slice(0, limit);
}
