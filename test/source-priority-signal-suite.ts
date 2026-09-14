/**
 * Supply Discovery gate C5 — priority signal (docs/c5-implementation-plan.md
 * §2a, §12). Real-infra suite (self-skips if env unavailable) against the
 * real, already-ingested catalog — deliberately NOT synthetic fixtures for
 * the core aggregation logic, since the whole point of §2a is that its
 * output must be traceable to real market-supply data. A small amount of
 * synthetic seeding is used only for the two invariant checks that need a
 * guaranteed-known state (never-invents-a-candidate, never-touches-C2).
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import {
  computeCatalogPrioritySignal,
  computeWeakUserBias,
  rankPriorityCandidates,
} from '../src/lib/ingestion/source-priority-signal';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function skip(message: string) {
  skipped++;
  console.log(`  – SKIP: ${message}`);
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5 — PRIORITY SIGNAL (§2a)');
  console.log('==============================================================================\n');

  console.log('1. UNIT — rankPriorityCandidates() never invents a candidate (synthetic input, no infra)');
  {
    const catalogSignal = {
      skillFrequency: { python: 10, react: 8, sql: 5 },
      companyFrequency: { Acme: 4, Globex: 3, Initech: 1 },
      companySkills: { Acme: new Set(['python', 'sql']), Globex: new Set(['react']), Initech: new Set(['python']) },
      companyRemoteTypes: { Acme: new Set(['worldwide']), Globex: new Set(['us_only']), Initech: new Set(['unknown']) },
      remoteTypeDistribution: { worldwide: 4, us_only: 3, unknown: 1 },
      totalActiveRows: 8,
    };
    const userBias = { weakSignal: true as const, rawSkillCounts: { python: 50, brandnewfakeskill: 999 }, rawTargetRoleCounts: {} };

    const ranked = await rankPriorityCandidates(catalogSignal, userBias, { minPostings: 1 });
    const inputCompanies = new Set(Object.keys(catalogSignal.companyFrequency));
    assert(
      ranked.every((c) => inputCompanies.has(c.company)),
      'every ranked candidate.company is drawn from the input catalog signal — never a company absent from real ingested data'
    );
    assert(ranked.length === 3, `all 3 input companies pass minPostings:1 (got ${ranked.length})`);
    assert(ranked[0].company === 'Acme', 'sort is primarily by catalogPostingFrequency (Acme:4 ranks first)');
    assert(ranked.every((c) => c.weakUserBiasScore !== undefined), 'weakUserBiasScore is present but never overrides the primary sort key above');

    const rankedMinPostings2 = await rankPriorityCandidates(catalogSignal, userBias, { minPostings: 2 });
    assert(
      !rankedMinPostings2.some((c) => c.company === 'Initech'),
      'a company below minPostings threshold (Initech: 1 posting) is excluded, not padded in'
    );

    // A company/skill genuinely absent from the catalog input (even with a
    // huge weak-bias count) must never appear as a candidate.
    assert(
      !ranked.some((c) => c.matchedHighFrequencySkills.includes('brandnewfakeskill')),
      'a user-only skill with zero catalog presence never appears as a matched high-frequency skill'
    );
  }

  console.log('\n2. UNIT — per-company skill/remote-type tracking is genuinely per-company, not a shared generic list');
  {
    const catalogSignal = {
      skillFrequency: { python: 10, go: 10 }, // tied frequency, both "top"
      companyFrequency: { PythonShop: 3, GoShop: 3 },
      companySkills: { PythonShop: new Set(['python']), GoShop: new Set(['go']) },
      companyRemoteTypes: { PythonShop: new Set(['worldwide']), GoShop: new Set(['eu_eea']) },
      remoteTypeDistribution: { worldwide: 3, eu_eea: 3 },
      totalActiveRows: 6,
    };
    const userBias = { weakSignal: true as const, rawSkillCounts: {}, rawTargetRoleCounts: {} };
    const ranked = await rankPriorityCandidates(catalogSignal, userBias, { minPostings: 1 });

    const pythonShop = ranked.find((c) => c.company === 'PythonShop');
    const goShop = ranked.find((c) => c.company === 'GoShop');
    assert(
      !!pythonShop && pythonShop.matchedHighFrequencySkills.includes('python') && !pythonShop.matchedHighFrequencySkills.includes('go'),
      "PythonShop's matched skills reflect ONLY its own postings' skills (python), never GoShop's (go) — the original generic-top-5-list bug this module was corrected for"
    );
    assert(
      !!goShop && goShop.matchedHighFrequencySkills.includes('go') && !goShop.matchedHighFrequencySkills.includes('python'),
      "GoShop's matched skills reflect ONLY its own postings' skills (go), never PythonShop's (python)"
    );
    assert(
      (pythonShop?.observedRemoteTypes.includes('worldwide') && !pythonShop?.observedRemoteTypes.includes('eu_eea')) ?? false,
      "each candidate's observedRemoteTypes reflects only ITS OWN company's postings, not a catalog-wide aggregate"
    );
  }

  console.log('\n3. REAL-INFRA — against the real catalog (self-skips if env unavailable)');
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();

    const catalogSignal = await computeCatalogPrioritySignal();
    assert(catalogSignal.totalActiveRows > 0, `real catalog aggregation returns a nonzero active-row count (got ${catalogSignal.totalActiveRows})`);
    assert(Object.keys(catalogSignal.companyFrequency).length > 0, 'real catalog aggregation produces at least one company frequency entry');
    assert(Object.keys(catalogSignal.skillFrequency).length > 0, 'real catalog aggregation produces at least one skill frequency entry');

    const { data: activeRows } = await admin.from('opportunities').select('company', { count: 'exact', head: false }).eq('status', 'active');
    const realCompanyCount = new Set((activeRows ?? []).map((r: any) => r.company).filter(Boolean)).size;
    assert(
      Object.keys(catalogSignal.companyFrequency).length === realCompanyCount,
      `distinct companies in the computed signal (${Object.keys(catalogSignal.companyFrequency).length}) matches a fresh independent DB count (${realCompanyCount})`
    );

    const userBias = await computeWeakUserBias();
    assert(userBias.weakSignal === true, 'computeWeakUserBias() always returns weakSignal: true — load-bearing, not decorative');
    assert(
      typeof userBias === 'object' && !('normalizedScore' in userBias) && !('demandScore' in userBias),
      'the weak user bias signal never carries anything shaped like a normalized/published demand score'
    );

    const ranked = await rankPriorityCandidates(catalogSignal, userBias);
    assert(Array.isArray(ranked), 'rankPriorityCandidates() against the real catalog returns a ranked array');
    const realCompanySet = new Set(Object.keys(catalogSignal.companyFrequency));
    assert(
      ranked.every((c) => realCompanySet.has(c.company)),
      'every real-catalog-derived candidate is a company already present in the real, already-ingested catalog — never invented'
    );
    assert(
      ranked.every((r, i) => i === 0 || ranked[i - 1].catalogPostingFrequency >= r.catalogPostingFrequency),
      'real-catalog ranking is sorted descending by catalogPostingFrequency'
    );

    console.log('\n4. Zero reads from C2\'s gated demand_gap_snapshots or any C2 artifact');
    const sourceFiles = [
      'src/lib/ingestion/source-priority-signal.ts',
    ];
    const fs = await import('fs');
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      // The header comment legitimately documents BY NAME what this module
      // does NOT touch — that's the point of a clear boundary statement.
      // What actually matters is that neither table is ever the target of
      // an actual query (.from('...')).
      assert(
        !content.includes(".from('demand_gap_snapshots')"),
        `${file} never actually QUERIES demand_gap_snapshots (C2's gated table) — it may only mention it by name in explanatory comments`
      );
      assert(
        !content.includes(".from('demand_pattern_sources')"),
        `${file} never actually QUERIES demand_pattern_sources`
      );
    }
  }

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running source-priority-signal suite:', e); process.exit(1); });
