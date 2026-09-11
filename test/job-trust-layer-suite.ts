/**
 * M — Job Trust Layer.
 * ==============================================================================
 *   1. trust-signals.ts (pure) — every helper, every enum branch incl.
 *      undefined; remoteScopeCaveat never phrases 'unknown' as a negative
 *      claim; employerDirectApplyLabel is non-null ONLY for 'curated' (M10.1);
 *      salaryQualifierLabel/linkVerifiedLabel never invent a fact when the
 *      underlying field is absent.
 *   2. Static — job-card.tsx (M8: the swipe/feed card stays exactly as H left
 *      it) never imports trust-signals.ts; engine.ts has zero diff; no new
 *      migration file; no new API route; match-analysis-view.tsx's old
 *      "$140k – $180k · Full-time" fabrication (M10.2) is gone and reuses the
 *      shared formatSalary().
 *
 * Run: npx tsx test/job-trust-layer-suite.ts
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import {
  sourceDisplayName,
  remoteScopeCaveat,
  salaryQualifierLabel,
  linkVerifiedLabel,
  employerDirectApplyLabel,
} from '../src/lib/feed/trust-signals';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

async function run() {
  console.log('='.repeat(78));
  console.log('M — JOB TRUST LAYER');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. trust-signals.ts (pure, all branches)');
  // ==========================================================================
  {
    // sourceDisplayName
    assert(sourceDisplayName('curated') === 'Curated by RemoteMatch', 'curated -> "Curated by RemoteMatch"');
    assert(sourceDisplayName('remotive') === 'Remotive', 'remotive -> "Remotive"');
    assert(sourceDisplayName('arbeitnow') === 'Arbeitnow', 'arbeitnow -> "Arbeitnow"');
    assert(sourceDisplayName('jobicy') === 'Jobicy', 'jobicy -> "Jobicy"');
    const future = sourceDisplayName('greenhouse');
    assert(future === 'Greenhouse', `unmapped slug is Title-cased, not "unknown" (got "${future}")`);
    assert(sourceDisplayName('') === 'Unknown', 'empty source falls back to "Unknown" (never a blank label)');

    // remoteScopeCaveat — never a negative claim for 'unknown'
    assert(
      remoteScopeCaveat('explicit_worldwide') === 'This posting explicitly states worldwide remote work.',
      'explicit_worldwide caveat text',
    );
    assert(
      remoteScopeCaveat('explicit_restricted') === 'This posting explicitly states a geographic restriction.',
      'explicit_restricted caveat text',
    );
    const unk = remoteScopeCaveat('unknown');
    const undef = remoteScopeCaveat(undefined);
    assert(unk === undef, "'unknown' and undefined produce the IDENTICAL caveat (both mean 'no explicit statement')");
    assert(!/not worldwide/i.test(unk) && !/\bnot\b.*worldwide/i.test(unk), 'unknown caveat is never phrased as "not worldwide" (M4 constraint)');
    assert(/doesn.?t clearly state/i.test(unk), 'unknown caveat is an absence-of-information statement');

    // salaryQualifierLabel — only ever attached when a real number is ALSO
    // going to render (mirrors formatSalary()'s own condition exactly)
    assert(salaryQualifierLabel({ salaryQuality: 'verified', salaryMin: 100000, salaryMax: 140000 }) === 'Reported', "verified + real numbers -> 'Reported'");
    assert(salaryQualifierLabel({ salaryQuality: 'estimated', salaryMin: 80000 }) === 'Estimated', "estimated + a real number -> 'Estimated'");
    assert(salaryQualifierLabel({ salaryQuality: 'unspecified', salaryMin: undefined, salaryMax: undefined }) === null, "'unspecified' -> null (nothing to qualify)");
    assert(salaryQualifierLabel({ salaryQuality: undefined, salaryMin: undefined, salaryMax: undefined }) === null, 'undefined salaryQuality -> null');
    assert(
      salaryQualifierLabel({ salaryQuality: 'estimated', salaryMin: undefined, salaryMax: undefined }) === null,
      'BUG GUARD: salaryQuality "estimated" with NO numeric salaryMin/salaryMax -> null, never a qualifier next to "Salary not listed" (a real production data shape: an unparsed free-text salaryString)',
    );
    assert(
      salaryQualifierLabel({ salaryQuality: 'verified', salaryMin: 0, salaryMax: 0 }) === null,
      'salaryMin/salaryMax of exactly 0 does not count as a real number (matches formatSalary()\'s own `> 0` check)',
    );

    // linkVerifiedLabel — never invents a date
    assert(linkVerifiedLabel(null) === null, 'null linkCheckedAt -> null');
    assert(linkVerifiedLabel(undefined) === null, 'undefined linkCheckedAt -> null');
    assert(linkVerifiedLabel('not-a-date') === null, 'unparseable linkCheckedAt -> null, never a garbage date');
    const real = linkVerifiedLabel('2026-09-01T00:00:00.000Z');
    assert(typeof real === 'string' && real.startsWith('Link verified '), `a real ISO date produces "Link verified ..." (got "${real}")`);

    // employerDirectApplyLabel — M10.1: ONLY 'curated'
    assert(employerDirectApplyLabel('curated') === 'Apply directly through the employer', "'curated' gets the employer-direct label");
    assert(employerDirectApplyLabel('remotive') === null, "'remotive' does NOT get the employer-direct label (officialUrl === sourceUrl, no domain evidence)");
    assert(employerDirectApplyLabel('arbeitnow') === null, "'arbeitnow' does NOT get the employer-direct label");
    assert(employerDirectApplyLabel('jobicy') === null, "'jobicy' does NOT get the employer-direct label");
    assert(employerDirectApplyLabel('greenhouse') === null, 'a future/unknown source does NOT get the employer-direct label by default (no evidence anticipated)');
  }

  // ==========================================================================
  console.log('\n2. STATIC — M8 card boundary, engine.ts untouched, salary fabrication fixed');
  // ==========================================================================
  {
    const jobCard = readFileSync(join(__dirname, '../src/components/feed/job-card.tsx'), 'utf8');
    assert(!jobCard.includes('trust-signals'), 'job-card.tsx never imports trust-signals.ts (M8: the swipe/feed card is untouched)');
    assert(!jobCard.includes('sourceDisplayName') && !jobCard.includes('remoteScopeCaveat') && !jobCard.includes('employerDirectApplyLabel'), 'job-card.tsx contains none of the new trust helpers');

    const modal = readFileSync(join(__dirname, '../src/components/feed/job-details-modal.tsx'), 'utf8');
    assert(modal.includes("from '@/lib/feed/trust-signals'"), 'job-details-modal.tsx wires the trust-signals helpers');
    assert(!modal.includes('capitalize">{opportunity.source}'), 'the raw, unexplained provider-slug badge is gone from the modal header');

    const view = readFileSync(join(__dirname, '../src/components/match/match-analysis-view.tsx'), 'utf8');
    assert(!view.includes("'$140k – $180k · Full-time'"), 'the fabricated "$140k – $180k · Full-time" salary literal is gone from Match Detail (M10.2)');
    assert(view.includes('formatSalary(opportunity)'), 'Match Detail reuses the shared formatSalary() — no duplicate formatter (M10.2 constraint)');
    assert(view.includes("from '@/lib/feed/trust-signals'"), 'Match Detail wires the same trust-signals helpers as the modal — no duplicated logic');

    try {
      const diff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(diff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD (engine.ts untouched)');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }

    const migrationsDir = join(__dirname, '../supabase/migrations');
    if (existsSync(migrationsDir)) {
      try {
        const untracked = execSync('git status --porcelain supabase/migrations', { cwd: join(__dirname, '..'), encoding: 'utf8' });
        assert(untracked.trim() === '', `no new/modified migration file for M (got: ${untracked.trim() || 'none'})`);
      } catch (e: any) {
        skip(`git status check unavailable (${e.message})`);
      }
    }

    const apiDir = join(__dirname, '../src/app/api');
    const beforeApiRoutes = [
      'ai', 'applications', 'demand', 'health', 'onboarding', 'opportunities', 'profile',
      'resume', 'seo', 'staging', 'stripe',
    ];
    const currentApiDirs = readdirSync(apiDir).sort();
    assert(
      currentApiDirs.every((d) => beforeApiRoutes.includes(d)),
      `no new top-level API route directory added for M (got: ${currentApiDirs.join(', ')})`,
    );
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running job-trust-layer suite:', e); process.exit(1); });
