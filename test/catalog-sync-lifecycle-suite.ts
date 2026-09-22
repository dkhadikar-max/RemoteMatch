/**
 * RemoteMatch — Phase A Item 1b: catalog-sync lifecycle correctness suite
 * ==============================================================================
 * Proves the corrected lifecycle (src/lib/ingestion/catalog-sync-plan.ts +
 * catalog-sync-apply.ts, dispatched by CATALOG_SYNC_MODE) against
 * docs/phase-a-item-1b-spec.md.
 *
 *   §0  static     mode dispatch / default-legacy / legacy path preserved
 *   §1  planner    pure-function tests, no I/O (incl. the Himalayas scenario
 *                  that makes a literal "paginate the absence scan" fix unsafe)
 *   §2  failures   a fake client proves fail-closed behaviour (lookup failure
 *                  aborts before any write; a failed absence scan is skipped
 *                  and reported, never silently continued)
 *   §3  real infra against the production Supabase project, every synthetic
 *                  row under a test source_id prefix and removed afterwards,
 *                  real rows of the touched sources fingerprinted before/after:
 *                    - >1,000-row scale run (the PostgREST cap) end to end
 *                    - checked inserts, duplicates counted as conflicts
 *                    - awkward source_ids survive the targeted lookup
 *                    - evidence-bounded absence, retirement, limiter, observe
 *                    - deadline + re-verification of stuck 'unknown' rows
 *                    - corrected rows are byte-identical to legacy rows
 *                    - shadow mode's planner writes nothing
 *                    - characterization of the legacy defect (delete with the
 *                      legacy path once `full` is proven)
 *
 * Run: npx tsx --env-file=.env.local test/catalog-sync-lifecycle-suite.ts
 * (Never run within ~15 minutes of the 00/06/12/18 UTC ingestion cron.)
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
delete process.env.CATALOG_SYNC_MODE;

import fs from 'fs';
import path from 'path';
import { syncOpportunitiesToCatalog, resolveSyncMode, ProviderFetchResult } from '../src/lib/ingestion/catalog-sync';
import { planCatalogSyncReadOnly, buildCatalogPlan, insertRowsIgnoringDuplicates, readApprovedEmployers, RunContext, RollbackEntry } from '../src/lib/ingestion/catalog-sync-apply';
import { getApprovedEmployers } from '../src/lib/ingestion/employer-registry';
import {
  CONTENT_FIELD_NAMES,
  buildContentFields,
  contentDiffers,
  computeSourceCoverage,
  coverageKindFor,
  isGateRejected,
  scopeSlugFor,
  classifyEmployerScopes,
  buildScopeGate,
  windowMetrics,
  EmployerScopeInfo,
  planAbsence,
  planUpserts,
  ExistingRow,
  ActiveScanRow,
  NormalizedOpp,
  UpsertPolicy,
} from '../src/lib/ingestion/catalog-sync-plan';
import { normalizeOpportunity, deduplicateOpportunities } from '../src/lib/ingestion/pipeline';
import { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function raw(over: Partial<RawJobPayload> & { sourceId: string }): RawJobPayload {
  return {
    source: 'remotive',
    title: `Lifecycle Engineer ${over.sourceId}`,
    company: 'Lifecycle Co',
    description: `Build things ${over.sourceId}. `.repeat(20),
    officialUrl: `https://lifecycle1b-suite.invalid/j/${encodeURIComponent(over.sourceId)}`,
    jobType: 'Full-time',
    publicationDate: iso(H),
    ...over,
  };
}
function norm(over: Partial<RawJobPayload> & { sourceId: string }): NormalizedOpp {
  return normalizeOpportunity(raw(over));
}
function fetchOf(jobsBySource: Record<string, RawJobPayload[] | 'fail'>, fetchStartedAt?: number): ProviderFetchResult {
  const outcomes = Object.entries(jobsBySource).map(([sourceKey, jobs]) => ({
    sourceKey,
    success: jobs !== 'fail',
    jobCount: jobs === 'fail' ? 0 : jobs.length,
    ...(jobs === 'fail' ? { error: 'synthetic failure' } : {}),
  }));
  const successfulRaw = new Map<string, RawJobPayload[]>();
  for (const [k, v] of Object.entries(jobsBySource)) if (v !== 'fail') successfulRaw.set(k, v);
  return { outcomes, successfulRaw, ...(fetchStartedAt !== undefined ? { fetchStartedAt } : {}) };
}

const POLICY: UpsertPolicy = {
  now: new Date(NOW).toISOString(),
  atsGated: new Set(['greenhouse', 'lever', 'ashby']),
  passesFreshness: (p) => NOW - Date.parse(p) <= 48 * H,
  isWeakDescription: (d) => (d || '').trim().length < 100,
  skipsVerification: (s) => s === 'curated',
};
const ABS = (over: Partial<Parameters<typeof planAbsence>[4]> = {}) => ({
  threshold: 3,
  retirementDays: 7 as number | null,
  nowMs: NOW,
  withholdExpiry: false,
  releaseLimiter: false,
  ...over,
});
const scanRow = (id: string, sourceId: string, over: Partial<ActiveScanRow> = {}): ActiveScanRow => ({
  id,
  source_id: sourceId,
  consecutive_absences: 0,
  posted_at: iso(2 * H),
  last_seen_in_feed_at: iso(H),
  first_seen_at: iso(3 * H),
  ...over,
});

// ===========================================================================
async function section0Static() {
  console.log('\n0. STATIC — dispatch, default, legacy preserved');
  const sync = fs.readFileSync(path.resolve(__dirname, '../src/lib/ingestion/catalog-sync.ts'), 'utf8');
  const apply = fs.readFileSync(path.resolve(__dirname, '../src/lib/ingestion/catalog-sync-apply.ts'), 'utf8');

  assert(resolveSyncMode() === 'legacy', 'no CATALOG_SYNC_MODE => legacy (deploying is a no-op until the variable is set)');
  assert(resolveSyncMode('garbage') === 'legacy', 'an unrecognised mode falls back to legacy, never to a write path');
  assert(resolveSyncMode(' FULL ') === 'full' && resolveSyncMode('shadow') === 'shadow' && resolveSyncMode('observe') === 'observe', 'modes are parsed case/space-insensitively');
  assert(/async function syncOpportunitiesToCatalogLegacy/.test(sync) && /\.in\('source', successfulSources\)/.test(sync), 'the legacy body is still present in catalog-sync.ts');
  assert(/if \(mode === 'legacy'\) return syncOpportunitiesToCatalogLegacy/.test(sync), 'legacy mode short-circuits to the legacy function before touching anything else');
  assert(/fetchAllRows/.test(apply) && /ignoreDuplicates: true/.test(apply), 'the applier uses keyset pagination and race-safe ignoreDuplicates inserts');
  assert(!/\.range\(/.test(apply) && !/\.single\(\)/.test(apply), 'the applier uses neither unordered .range() paging nor .single()');
  const writes = apply.match(/\.(update|upsert)\(/g)?.length ?? 0;
  const checked = apply.match(/\.select\('id(, source, source_id)?'\)/g)?.length ?? 0;
  assert(writes > 0 && checked >= writes, `every write in the applier returns rows for verification (${writes} writes, ${checked} row-returning selects)`);
}

// ===========================================================================
async function section1Planner() {
  console.log('\n1. PLANNER — pure functions');

  // --- content fields -------------------------------------------------------
  const a = norm({ sourceId: 'cf-1', salaryMin: 50000, salaryMax: 90000, salaryCurrency: 'EUR', tags: ['react', 'node'], locationString: 'Worldwide' });
  const f = buildContentFields(a);
  assert(JSON.stringify(Object.keys(f).sort()) === JSON.stringify([...CONTENT_FIELD_NAMES].sort()), 'buildContentFields yields exactly CONTENT_FIELD_NAMES');
  assert(!contentDiffers(f as any, f), 'identical content => not different');
  assert(contentDiffers({ ...f, salary_min: 1 } as any, f), 'a salary change is detected');
  const hashOnly = { ...f, salary_max: 12345 };
  assert(hashOnly.content_hash === f.content_hash && contentDiffers(hashOnly as any, f), 'salary/remote changes are caught even though content_hash cannot see them');
  assert(!contentDiffers({ ...f, salary_min: String(f.salary_min) } as any, f), 'numeric-string vs number is not a false change');
  assert(!contentDiffers({ ...f, company_logo: undefined } as any, { ...f, company_logo: null }), 'null vs undefined is not a false change');
  assert(contentDiffers({ ...f, required_skills: ['b', 'a'] } as any, { ...f, required_skills: ['a', 'b'] }), 'array order difference is treated as a change (errs toward the safe per-row UPDATE)');

  // --- planUpserts ------------------------------------------------------------
  const ex = (o: NormalizedOpp, status: string, over: Partial<ExistingRow> = {}): ExistingRow => ({
    id: `id-${o.sourceId}`,
    source: o.source,
    source_id: o.sourceId,
    status,
    consecutive_absences: 0,
    ...(buildContentFields(o) as any),
    ...over,
  });
  const key = (o: NormalizedOpp) => `${o.source}:${o.sourceId}`;
  const none = new Map<string, { isPermanentlyRemoved: boolean }>();

  const nNew = norm({ sourceId: 'p-new' });
  const nCur = norm({ sourceId: 'p-cur', source: 'curated' });
  const nWeak = norm({ sourceId: 'p-weak', description: 'short' });
  const nSame = norm({ sourceId: 'p-same' });
  const nChg = norm({ sourceId: 'p-chg' });
  const nExp = norm({ sourceId: 'p-exp' });
  const nUnk = norm({ sourceId: 'p-unk' });
  const nUnkCur = norm({ sourceId: 'p-unkcur', source: 'curated' });
  const nDraftSame = norm({ sourceId: 'p-draft', description: 'short' });
  const nOld = norm({ sourceId: 'p-old', source: 'greenhouse', publicationDate: iso(10 * D) });
  const nOverride = norm({ sourceId: 'p-ovr', source: 'curated', status: 'EXPIRED' as any });
  const existing = new Map<string, ExistingRow>([
    [key(nSame), ex(nSame, 'active')],
    [key(nChg), ex(nChg, 'active', { salary_min: 999999 })],
    [key(nExp), ex(nExp, 'expired')],
    [key(nUnk), ex(nUnk, 'unknown')],
    [key(nUnkCur), ex(nUnkCur, 'unknown')],
    [key(nDraftSame), ex(nDraftSame, 'draft')],
  ]);
  const overrides = new Map([[key(nOverride), { isPermanentlyRemoved: true }]]);
  const plan = planUpserts([nNew, nCur, nWeak, nSame, nChg, nExp, nUnk, nUnkCur, nDraftSame, nOld, nOverride], existing, overrides, POLICY);

  const kinds = Object.fromEntries(plan.inserts.map((i) => [i.sourceId, i.kind]));
  assert(kinds['p-new'] === 'unknown', 'new job => insert as unknown (verified after)');
  assert(kinds['p-cur'] === 'active' && (plan.inserts.find((i) => i.sourceId === 'p-cur')!.row as any).link_reachable === null, 'new curated job => insert active, no verification');
  assert(kinds['p-weak'] === 'draft', 'weak description => insert as draft');
  assert(kinds['p-ovr'] === 'expired' && (plan.inserts.find((i) => i.sourceId === 'p-ovr')!.row as any).is_permanently_removed === true, 'explicit EXPIRED override => insert expired + is_permanently_removed');
  assert(plan.touchIds.includes('id-p-same') && !plan.contentUpdates.some((u) => u.id === 'id-p-same'), 'unchanged existing row => bulk touch, no content rewrite');
  assert(plan.contentUpdates.some((u) => u.id === 'id-p-chg' && u.kind === 'refresh' && (u.patch as any).consecutive_absences === 0), 'changed existing row => per-row refresh that also resets absences');
  assert(plan.contentUpdates.some((u) => u.id === 'id-p-exp' && u.kind === 'reappeared') && plan.verify.some((v) => v.id === 'id-p-exp' && v.reason === 'reappeared'), 'expired row seen again => refreshed and RE-VERIFIED, never assumed active');
  assert(plan.verify.some((v) => v.id === 'id-p-unk' && v.reason === 'unknown'), 'FIX H: an unknown row seen again is re-queued for verification');
  assert(plan.curatedReactivateIds.includes('id-p-unkcur'), 'an unknown curated row is activated without a link check');
  assert(plan.draftTouchIds.includes('id-p-draft'), 'unchanged draft row => last_seen only (not absence-tracked)');
  assert(plan.gateSkipped === 1 && !plan.inserts.some((i) => i.sourceId === 'p-old'), 'ATS freshness gate: stale job is never inserted');

  // --- coverage / floor -------------------------------------------------------
  const by = new Map<string, NormalizedOpp[]>([
    ['himalayas', [norm({ sourceId: 'h1', publicationDate: iso(12 * H) }), norm({ sourceId: 'h2', publicationDate: iso(3 * H) })]],
    ['greenhouse', [norm({ sourceId: 'g1', source: 'greenhouse' })]],
    ['empty', []],
  ]);
  const cov = computeSourceCoverage(by, ['himalayas', 'greenhouse', 'empty']);
  const him = cov.get('himalayas')!;
  assert(him.coverage === 'windowed' && (him as any).floorMs === Date.parse(iso(12 * H)), 'windowed floor = oldest postedAt fetched this cycle');
  assert(cov.get('greenhouse')!.coverage === 'complete', 'ATS boards are complete-coverage');
  assert(cov.get('empty')!.coverage === 'windowed' && (cov.get('empty') as any).floorMs === null, 'a windowed source that returned nothing has NO observable rows (null floor)');
  assert(computeSourceCoverage(new Map(), ['brand-new-provider']).get('brand-new-provider')!.coverage === 'windowed', 'an unknown future provider defaults to windowed (safe)');

  // --- planAbsence ------------------------------------------------------------
  const win = { coverage: 'windowed' as const, floorMs: NOW - 12 * H };
  const rows: ActiveScanRow[] = [
    scanRow('present', 'present', { posted_at: iso(H) }),
    scanRow('obs-absent', 'gone', { posted_at: iso(5 * H) }),
    scanRow('obs-c2', 'gone2', { posted_at: iso(6 * H), consecutive_absences: 2 }),
    scanRow('old', 'aged-out', { posted_at: iso(40 * H) }),
    scanRow('old-stale', 'aged-out-stale', { posted_at: iso(40 * H), last_seen_in_feed_at: iso(9 * D) }),
  ];
  const p = planAbsence('himalayas', rows, new Set(['present']), win, ABS());
  assert(p.present === 1 && p.unobservable === 2, 'present rows skipped; rows older than the floor are unobservable');
  assert(p.incrementByValue.get(1)?.join() === 'obs-absent', 'an observable absent row gains an absence');
  assert(p.expireIds.join() === 'obs-c2', 'an observable absent row at 2 expires at 3');
  assert(!p.incrementByValue.get(1)?.includes('old') && !p.expireIds.includes('old'), 'an unobservable row is never counted absent');
  assert(p.retireIds.join() === 'old-stale', 'retirement: unobservable + unseen > 7 days => retired');
  assert(planAbsence('himalayas', rows, new Set(['present']), win, ABS({ retirementDays: null })).retireIds.length === 0, 'retirementDays: null disables retirement');

  const comp = planAbsence('greenhouse', rows, new Set(['present']), { coverage: 'complete' }, ABS());
  assert(comp.unobservable === 0 && comp.expireIds.includes('obs-c2') && (comp.incrementByValue.get(1) ?? []).includes('old'), 'complete-coverage sources: every absent row counts, whatever its age');
  assert(planAbsence('x', rows, new Set(), { coverage: 'windowed', floorMs: null }, ABS()).unobservable === 5, 'no date evidence => nothing observable');

  // --- v2: coverage policy, exempt, R4, shared gate definition ------------------
  assert(coverageKindFor('weworkremotely') === 'exempt', 'v2 policy: WWR is exempt');
  assert(['greenhouse', 'lever', 'ashby', 'curated'].every((s) => coverageKindFor(s) === 'complete'), 'v2 policy: ATS boards + curated are complete');
  assert(['himalayas', 'jobicy', 'arbeitnow', 'remotive', 'remoteok', 'some-new-provider'].every((s) => coverageKindFor(s) === 'windowed'), 'v2 policy: every other source (incl. unknown future ones) is windowed');
  assert(computeSourceCoverage(new Map(), ['weworkremotely']).get('weworkremotely')!.coverage === 'exempt', 'computeSourceCoverage reports WWR as exempt');
  const wwrRows: ActiveScanRow[] = [
    scanRow('w-present', 'present', { posted_at: iso(H) }),
    scanRow('w-recent', 'recent-absent', { posted_at: iso(2 * H), consecutive_absences: 2 }),
    scanRow('w-old', 'old-absent', { posted_at: iso(90 * D), consecutive_absences: 1 }),
    scanRow('w-stale', 'stale-absent', { posted_at: iso(90 * D), last_seen_in_feed_at: iso(9 * D) }),
  ];
  const wp = planAbsence('weworkremotely', wwrRows, new Set(['present']), { coverage: 'exempt' }, ABS());
  assert(wp.present === 1 && wp.unobservable === 3, 'exempt: every absent row is unobservable (even one posted 2h ago)');
  assert(wp.expireIds.length === 0 && wp.incrementByValue.size === 0 && wp.wouldExpire === 0, 'exempt: NOTHING is incremented or expired by absence — the legacy 3-absence rule is not used');
  assert(wp.retireIds.join() === 'w-stale' && wp.wouldRetire === 1, 'exempt: a row unseen > 7 days is still retired (the only exit)');
  assert(planAbsence('weworkremotely', wwrRows, new Set(['present']), { coverage: 'exempt' }, ABS({ retirementDays: null })).retireIds.length === 0, 'exempt: retirement follows the retirementDays switch');
  assert(wp.legacyCountersInflated === 2, `exempt: rows already carrying a legacy counter are reported as frozen, not changed (frozen=${wp.legacyCountersInflated})`);
  const r4 = planAbsence('himalayas', [scanRow('r4', 'r4', { consecutive_absences: 2, posted_at: iso(3 * H) })], new Set(), { coverage: 'windowed', floorMs: NOW - 12 * H }, ABS());
  assert(r4.expireIds.join() === 'r4', 'R4 (documented): an observable row already at counter 2 expires after ONE valid absence — legacy-accrued counters are deliberately left unchanged (D-N2)');
  const gp = { atsGated: POLICY.atsGated, passesFreshness: POLICY.passesFreshness };
  assert(isGateRejected(norm({ sourceId: 'g-old', source: 'greenhouse', publicationDate: iso(10 * D) }), gp) === true, 'isGateRejected: stale ATS job');
  assert(isGateRejected(norm({ sourceId: 'g-nonats', source: 'remotive', publicationDate: iso(10 * D) }), gp) === false, 'isGateRejected: the gate never applies to non-ATS sources');

  // --- v2.1: employer-scope slug matching, classification, gate, window metrics ---------
  const cov1 = computeSourceCoverage(new Map([['himalayas', [norm({ sourceId: 'w1', publicationDate: iso(12 * H) }), norm({ sourceId: 'w2', publicationDate: iso(3 * H) })]]]), ['himalayas']).get('himalayas')!;
  assert(cov1.coverage === 'windowed' && (cov1 as any).newestMs === Date.parse(iso(3 * H)), 'v2.1: windowed coverage now also records the newest postedAt fetched');

  const knownSlugs = ['zeta', 'zeta-global', 'outreach', 'spotify'];
  assert(scopeSlugFor('lever', 'lever-zeta-global-9f3-aa', knownSlugs) === 'zeta-global', 'rule L.1: the LONGEST known slug wins (zeta-global beats zeta)');
  assert(scopeSlugFor('lever', 'lever-zeta-9f3-aa', knownSlugs) === 'zeta', 'rule L.1: a shorter slug still matches when the longer one does not');
  assert(scopeSlugFor('lever', 'lever-zetaX-1', knownSlugs) === null, 'rule L.1: a prefix not delimited by "-" is not a match');
  assert(scopeSlugFor('lever', 'greenhouse-spotify-1', knownSlugs) === null && scopeSlugFor('lever', 'nonsense', knownSlugs) === null, 'rule L.1: wrong provider prefix / garbage => null (never guessed by splitting on "-")');

  const emp = (slug: string, succ: number | null, att: number | null, linked: string | null = 'src'): EmployerScopeInfo => ({ boardSlug: slug, linkedSourceId: linked, lastSuccessMs: succ, lastAttemptMs: att });
  const T0 = NOW;
  const cls = classifyEmployerScopes({
    employers: [emp('ok', T0 + 1000, T0 + 1000), emp('failed', T0 - 5000, T0 + 500), emp('notreached', T0 - 5000, T0 - 5000), emp('never', null, null), emp('unlinked', null, null, null), emp('emptyclosed', T0 + 10, T0 + 10), emp('emptyfailed', T0 - 9, T0 + 5), emp('emptynoactive', T0 + 10, T0 + 10)],
    fetchedRawBySlug: new Map([['ok', 5], ['emptyclosed', 0], ['emptynoactive', 0]]),
    activeBySlug: new Map([['ok', 4], ['failed', 2], ['emptyclosed', 3], ['emptyfailed', 2], ['emptynoactive', 0]]),
    fetchStartedAtMs: T0,
  });
  assert(cls.get('ok')!.observable, 'rule L.2: success stamped at/after fetchStartedAt => observable');
  assert(cls.get('failed')!.reason === 'fetch-failed', 'rule L.2: an attempt recorded this run with no success => fetch-failed');
  assert(cls.get('notreached')!.reason === 'not-attempted' && cls.get('never')!.reason === 'not-attempted', 'rule L.2: old/absent stamps (not reached, or a lost bookkeeping write) => not-attempted (fail-closed)');
  assert(cls.get('unlinked')!.reason === 'evidence-unavailable', 'rule L.2: an employer with no linked supply_sources row cannot be proven => evidence-unavailable');
  assert(cls.get('emptyclosed')!.reason === 'zero-rows-with-active', 'rule L.3: bookkeeping says success but 0 rows returned while active rows exist => unobservable (backstop)');
  assert(cls.get('emptynoactive')!.observable, 'rule L.3: 0 rows returned and nothing active => nothing to lose, observable');
  assert(cls.get('emptyfailed')!.reason === 'fetch-failed', 'a bookkeeping failure takes precedence over the backstop reason');
  const bo = classifyEmployerScopes({ employers: [emp('old', T0 - 999999, null), emp('empty', T0 - 999999, null)], fetchedRawBySlug: new Map([['old', 3]]), activeBySlug: new Map([['old', 3], ['empty', 2]]), fetchStartedAtMs: null });
  assert(bo.get('old')!.observable && bo.get('empty')!.reason === 'zero-rows-with-active', 'backstop-only mode ignores timestamps entirely and still applies the zero-rows backstop');

  const gate = buildScopeGate('lever', ['good', 'bad'], new Map([['good', { observable: true }], ['bad', { observable: false, reason: 'fetch-failed' as const }]]));
  const rowsL: ActiveScanRow[] = [
    scanRow('g1', 'lever-good-1'),
    scanRow('b1', 'lever-bad-1'),
    scanRow('b2', 'lever-bad-2', { consecutive_absences: 2 }),
    scanRow('u1', 'lever-gone-1'),
    scanRow('bstale', 'lever-bad-9', { last_seen_in_feed_at: iso(9 * D) }),
  ];
  const lp = planAbsence('lever', rowsL, new Set(), { coverage: 'complete' }, ABS(), gate);
  assert((lp.incrementByValue.get(1) ?? []).join() === 'g1', 'rule L.4: only the observable employer\'s row gains an absence');
  assert(lp.expireIds.length === 0 && lp.unobservable === 4, 'rule L.4: a failed employer\'s row at counter 2 is NOT expired, an unknown-employer row is unobservable too');
  assert(lp.retireIds.join() === 'bstale' && lp.legacyCountersInflated === 1, 'rule L.6: an unobservable-scope row unseen > 7 days IS retired (the only exit); the frozen counter is reported');
  const lpOff = planAbsence('lever', rowsL, new Set(), { coverage: 'complete' }, ABS());
  assert(lpOff.expireIds.join() === 'b2' && lpOff.unobservable === 0, 'rule L.7: without a scope gate (no fetch evidence) complete coverage behaves exactly as before');

  const wmA = windowMetrics({ coverage: 'windowed', floorMs: NOW - 10.68 * H, newestMs: NOW - 3.21 * H }, NOW);
  assert(wmA.windowHours === 10.68 && wmA.newestAgeHours === 3.21 && wmA.gapMarginHours === 1.47 && wmA.gapRisk === false, `D-N5: Cycle-2-shaped window (10.68h wide, newest 3.21h old) => margin +1.47h, no gap risk (${JSON.stringify(wmA)})`);
  const wmB = windowMetrics({ coverage: 'windowed', floorMs: NOW - 7.47 * H, newestMs: NOW - 3 * H }, NOW);
  assert(wmB.gapMarginHours === -1.53 && wmB.gapRisk === true, `D-N5: a 7.47h window with 3h publication lag cannot cover a 6h cadence => gapRisk (${JSON.stringify(wmB)})`);
  assert(windowMetrics({ coverage: 'windowed', floorMs: NOW - 8 * H }, NOW).gapMarginHours === 2 && windowMetrics({ coverage: 'windowed', floorMs: NOW - 8 * H }, NOW).newestAgeHours === null, 'D-N5: with no newest evidence the lag is assumed 0 and newestAgeHours is reported as null, not hidden');
  const wmN = [windowMetrics({ coverage: 'complete' }, NOW), windowMetrics({ coverage: 'exempt' }, NOW), windowMetrics({ coverage: 'windowed', floorMs: null }, NOW)];
  assert(wmN.every((m) => m.windowHours === null && m.gapMarginHours === null && m.gapRisk === false), 'D-N5: complete / exempt / no-date-evidence sources report nulls and no gap risk');

  // --- limiter / observe -------------------------------------------------------
  const big = Array.from({ length: 5000 }, (_, i) => scanRow(`b${i}`, `b${i}`, { consecutive_absences: 2 }));
  const held = planAbsence('s', big, new Set(), { coverage: 'complete' }, ABS());
  assert(held.held?.reason === 'limiter' && held.held.limit === 500 && held.held.planned === 5000 && held.expireIds.length === 0 && held.wouldExpire === 5000, 'limiter: 5,000 planned > max(200, 10% of 5,000 = 500) => ALL expiries held, still reported');
  assert(planAbsence('s', big, new Set(), { coverage: 'complete' }, ABS({ releaseLimiter: true })).expireIds.length === 5000, 'one-shot release lets the expiries through');
  const small = big.slice(0, 150);
  assert(planAbsence('s', small, new Set(), { coverage: 'complete' }, ABS()).expireIds.length === 150, 'the 200-row floor: 150 expiries of 150 rows pass');
  const obsv = planAbsence('s', small, new Set(), { coverage: 'complete' }, ABS({ withholdExpiry: true }));
  assert(obsv.held?.reason === 'observe-mode' && obsv.expireIds.length === 0 && obsv.wouldExpire === 150, 'observe mode: expiries planned and reported but never written');

  // --- THE scenario that makes the literal fix unsafe (spec §3) ------------------
  const himRows = Array.from({ length: 9466 }, (_, i) =>
    scanRow(`h${i}`, `h${i}`, { posted_at: iso((13 + (i % 180)) * H), consecutive_absences: i % 3, last_seen_in_feed_at: iso((6 + (i % 40)) * H) })
  );
  const fetchedIds = new Set(Array.from({ length: 1456 }, (_, i) => `f${i}`)); // a disjoint newest-1,500 window
  const naiveExpired = himRows.filter((r) => (r.consecutive_absences ?? 0) + 1 >= 3).length;
  const safe = planAbsence('himalayas', himRows, fetchedIds, { coverage: 'windowed', floorMs: NOW - 12 * H }, ABS());
  assert(naiveExpired > 3000, `(baseline) the literal rule would expire ${naiveExpired} live rows in one pass`);
  assert(safe.wouldExpire === 0 && safe.unobservable === 9466 && safe.retireIds.length === 0, 'evidence-bounded rule expires 0 of the same 9,466 rows (all older than the fetch window; none unseen > 7d)');
}

// ===========================================================================
type FakeQuery = { table: string; eq: Record<string, unknown>; inArgs: unknown[] | null; gt: unknown };
function fakeAdmin(handler: (q: FakeQuery) => { data: unknown; error: unknown }, seen?: FakeQuery[]) {
  return {
    from(table: string) {
      const st: FakeQuery = { table, eq: {}, inArgs: null, gt: null };
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => ((st.eq[c] = v), b),
        in: (_c: string, v: unknown[]) => ((st.inArgs = v), b),
        order: () => b,
        limit: () => b,
        like: () => b,
        gt: (_c: string, v: unknown) => ((st.gt = v), b),
        then: (res: any, rej: any) => (seen?.push(st), Promise.resolve(handler(st)).then(res, rej)),
      };
      return b;
    },
  } as any;
}
const registryOf = (...slugs: string[]) => ({ data: slugs.map((slug) => ({ slug })), error: null });

async function section2Failures() {
  console.log('\n2. FAIL-CLOSED / PRE-FLIGHT — fake client');
  const fetch = fetchOf({ remotive: [raw({ sourceId: 'fc-1' })] });

  let lookupErr = '';
  try {
    await buildCatalogPlan(fakeAdmin((q) => (q.table === 'supply_platforms' ? registryOf('remotive') : { data: null, error: { message: 'boom: connection reset', code: '08006' } })), fetch, undefined, 'full', new RunContext());
  } catch (e) {
    lookupErr = (e as Error).message;
  }
  assert(/existing-row lookup/.test(lookupErr) && /boom/.test(lookupErr), 'a failed existing-row lookup aborts the run with the real database error (before any write is possible)', lookupErr);

  let regErr = '';
  try {
    await buildCatalogPlan(fakeAdmin((q) => (q.table === 'supply_platforms' ? { data: null, error: { message: 'registry down', code: '57P03' } } : { data: [], error: null })), fetch, undefined, 'full', new RunContext());
  } catch (e) {
    regErr = (e as Error).message;
  }
  assert(/platform registry read/.test(regErr) && /registry down/.test(regErr), 'a failed platform-registry read aborts the run before anything is planned or written', regErr);

  const ctx = new RunContext();
  const plan = await buildCatalogPlan(
    fakeAdmin((q) => (q.table === 'supply_platforms' ? registryOf('remotive') : q.eq.status === 'active' ? { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } } : { data: [], error: null })),
    fetch,
    undefined,
    'full',
    ctx
  );
  assert(plan.absenceScanErrors.has('remotive') && !plan.absence.has('remotive'), 'a failed absence scan skips that source entirely — no partial absence accounting');
  assert(ctx.errors.some((e) => e.op === 'absence-scan(remotive)' && e.code === '57014'), 'the skipped scan is reported with its real error code, not silently continued');
  assert(plan.upserts.inserts.length === 1, 'upserts for the source are still planned (the failure is scoped to the absence pass)');

  // --- v2 §2 B: registry pre-flight -------------------------------------------------
  const seen: FakeQuery[] = [];
  const ctxU = new RunContext();
  const planU = await buildCatalogPlan(
    fakeAdmin((q) => (q.table === 'supply_platforms' ? registryOf('remotive') : { data: [], error: null }), seen),
    fetchOf({ remotive: [raw({ sourceId: 'u-ok' })], remoteok: [1, 2, 3].map((i) => raw({ sourceId: `ro-${i}`, source: 'remoteok' as any })) }),
    undefined,
    'full',
    ctxU
  );
  assert(JSON.stringify(planU.unregistered) === JSON.stringify([{ source: 'remoteok', fetched: 3, skippedInserts: 3 }]), 'an unregistered source is reported with its fetched/skipped counts', JSON.stringify(planU.unregistered));
  assert(planU.upserts.inserts.length === 1 && planU.upserts.inserts[0].source === 'remotive', 'no insert is planned for the unregistered source; the registered one is unaffected');
  assert(!seen.some((q) => q.eq.source === 'remoteok'), 'zero database requests of any kind (lookup, scan, backlog) are made for the unregistered source');
  assert(!planU.absence.has('remoteok') && !planU.coverage.has('remoteok'), 'and it is never absence-scanned');
  assert(ctxU.errors.some((e) => e.op === 'unregistered-source(remoteok)' && e.count === 3 && /supply_platforms/.test(e.sample)) && ctxU.writeFailures === 0, 'it is surfaced in errors[] every run, but NOT counted as a write failure (nothing was attempted)');
  const planR = await buildCatalogPlan(
    fakeAdmin((q) => (q.table === 'supply_platforms' ? registryOf('remotive', 'remoteok') : { data: [], error: null })),
    fetchOf({ remoteok: [1, 2, 3].map((i) => raw({ sourceId: `ro-${i}`, source: 'remoteok' as any })) }),
    undefined,
    'full',
    new RunContext()
  );
  assert(planR.unregistered.length === 0 && planR.upserts.inserts.length === 3, 'once the platform IS registered, the same fetch plans its 3 inserts normally (no code change needed)');

  // --- v2 §2 C: gate-rejected keys are not looked up, but still count as present -------------
  const fresh = raw({ sourceId: 'gh-fresh', source: 'greenhouse' as any, publicationDate: iso(H), locationString: 'Worldwide' });
  const stale = raw({ sourceId: 'gh-old', source: 'greenhouse' as any, publicationDate: iso(10 * D), locationString: 'Worldwide' });
  const seenG: FakeQuery[] = [];
  const planG = await buildCatalogPlan(
    fakeAdmin((q) => {
      if (q.table === 'supply_platforms') return registryOf('greenhouse');
      // keyset paging: rows on the first page only; the follow-up page (gt cursor set) is empty
      if (q.eq.status === 'active') return { data: q.gt ? [] : [scanRow('r-old', 'gh-old', { consecutive_absences: 1, posted_at: iso(10 * D) }), scanRow('r-gone', 'gh-gone')], error: null };
      return { data: [], error: null };
    }, seenG),
    fetchOf({ greenhouse: [fresh, stale] }),
    undefined,
    'full',
    new RunContext()
  );
  const lookup = seenG.find((q) => q.table === 'opportunities' && q.inArgs !== null);
  assert(norm({ sourceId: 'gh-fresh', source: 'greenhouse', publicationDate: iso(H), locationString: 'Worldwide' }).explicitRemoteScope !== 'unknown', 'setup: the fresh ATS fixture passes the remote-scope gate');
  assert(!!lookup && JSON.stringify(lookup.inArgs) === JSON.stringify(['gh-fresh']), `the gate-rejected key is NOT looked up (looked up: ${JSON.stringify(lookup?.inArgs)})`);
  assert(planG.lookupsSkippedByGate === 1 && planG.keysLookedUpBySource.get('greenhouse') === 1, 'the skip is counted');
  const ga = planG.absence.get('greenhouse')!;
  assert(ga.present === 1 && !(ga.incrementByValue.get(2) ?? []).includes('r-old') && !(ga.incrementByValue.get(1) ?? []).includes('r-old'), 'yet the gate-rejected row still counts as PRESENT — it is not absence-incremented');
  assert((ga.incrementByValue.get(1) ?? []).join() === 'r-gone', 'while a genuinely missing row (complete coverage) is');

  // --- v2.1 rule L end-to-end through buildCatalogPlan, fake client ---------------------------
  const START = NOW;
  const stamp = (ms: number) => new Date(ms).toISOString();
  const empRows = [
    { id: 'e1', canonical_name: 'Alpha', career_url: 'https://jobs.lever.co/alpha', linked_source_id: 'sa' },
    { id: 'e2', canonical_name: 'Beta', career_url: 'https://jobs.lever.co/beta', linked_source_id: 'sb' },
  ];
  const supRows = [
    { id: 'sa', last_successful_fetch_at: stamp(START + 1000), last_fetch_attempt_at: stamp(START + 1000) }, // fetched this run
    { id: 'sb', last_successful_fetch_at: stamp(START - 9999), last_fetch_attempt_at: stamp(START + 500) }, // attempted this run, no success = failed
  ];
  const activeL = [scanRow('a1', 'lever-alpha-1'), scanRow('a2', 'lever-alpha-2'), scanRow('b1', 'lever-beta-1', { consecutive_absences: 1 }), scanRow('b2', 'lever-beta-2', { consecutive_absences: 2 }), scanRow('g1', 'lever-gamma-1')];
  const atsFake = (o: { employers?: any[]; supply?: any[]; active?: ActiveScanRow[]; employerErr?: boolean; supplyErr?: boolean }, seen?: FakeQuery[]) =>
    fakeAdmin((q) => {
      if (q.table === 'supply_platforms') return registryOf('lever');
      if (q.table === 'allowlist_employers') return o.employerErr ? { data: null, error: { message: 'employer registry down', code: '57P03' } } : { data: o.employers ?? [], error: null };
      if (q.table === 'supply_sources') return o.supplyErr ? { data: null, error: { message: 'bookkeeping read timeout', code: '57014' } } : { data: (o.supply ?? []).filter((s) => (q.inArgs ?? []).includes(s.id)), error: null };
      if (q.eq.status === 'active') return { data: q.gt ? [] : o.active ?? [], error: null };
      return { data: [], error: null };
    }, seen);
  const jobA1 = raw({ sourceId: 'lever-alpha-1', source: 'lever' as any, publicationDate: iso(H), locationString: 'Worldwide' });

  const ctxL = new RunContext();
  const planL = await buildCatalogPlan(atsFake({ employers: empRows, supply: supRows, active: activeL }), fetchOf({ lever: [jobA1] }, START), undefined, 'full', ctxL);
  const la = planL.absence.get('lever')!;
  assert(planL.employerEvidence === 'bookkeeping', 'a real fetch (fetchStartedAt present) turns rule L on with bookkeeping evidence');
  assert((la.incrementByValue.get(1) ?? []).join() === 'a2' && la.present === 1, 'the SUCCESSFULLY fetched employer (alpha): its missing row gains an absence, normal behaviour');
  assert(la.expireIds.length === 0 && !(la.incrementByValue.get(2) ?? []).length, 'the FAILED employer (beta): its rows at counters 1 and 2 are neither incremented nor expired — the Spotify/Cycle-2 case');
  assert(JSON.stringify(planL.employerScopes.get('lever')) === JSON.stringify({ observable: 1, unobservable: 1, unobservableRows: 3 }), 'report: 1 observable employer, 1 unobservable, 3 active rows shielded', JSON.stringify(planL.employerScopes.get('lever')));
  assert(planL.unobservableScopes.some((s) => s.boardSlug === 'beta' && s.reason === 'fetch-failed' && s.activeRows === 2), 'report: beta is named with reason fetch-failed and its 2 rows');
  assert(planL.unobservableScopes.some((s) => s.boardSlug === '(unknown)' && s.reason === 'unknown-scope' && s.activeRows === 1), 'report: a row whose employer is no longer approved is unobservable (unknown-scope), not absence-expired');

  const ctxB = new RunContext();
  const planB = await buildCatalogPlan(atsFake({ employers: empRows, supplyErr: true, active: activeL }), fetchOf({ lever: [jobA1] }, START), undefined, 'full', ctxB);
  assert(planB.absenceScanErrors.has('lever') && !planB.absence.has('lever'), 'rule L.5: a failed bookkeeping read skips the WHOLE source\'s absence pass');
  assert(ctxB.errors.some((e) => e.op === 'employer-evidence(lever)' && e.code === '57014') && ctxB.writeFailures === 0, 'rule L.5: and reports it as employer-evidence(lever) with the real error code (not a write failure)');
  assert(planB.upserts.inserts.length === 1, 'the failure is scoped to the absence pass — upserts are still planned');
  const ctxC = new RunContext();
  const planC = await buildCatalogPlan(atsFake({ employerErr: true, active: activeL }), fetchOf({ lever: [jobA1] }, START), undefined, 'full', ctxC);
  assert(planC.absenceScanErrors.has('lever') && ctxC.errors.some((e) => e.op === 'employer-evidence(lever)' && /employer registry read/.test(e.sample)), 'rule L.5: a failed employer-registry read is also fail-closed and reported (getApprovedEmployers would have returned [] here, indistinguishable from "no employers")');

  const seenD: FakeQuery[] = [];
  const planD = await buildCatalogPlan(atsFake({ employers: empRows, supply: supRows, active: activeL }, seenD), fetchOf({ lever: [jobA1] }), undefined, 'full', new RunContext());
  assert(planD.employerEvidence === 'off' && !seenD.some((q) => q.table === 'allowlist_employers' || q.table === 'supply_sources'), 'rule L.7: an injected fetch (no fetchStartedAt) leaves the rule OFF — zero employer/bookkeeping queries');
  assert(planD.absence.get('lever')!.expireIds.includes('b2') && planD.unobservableScopes.length === 0, 'rule L.7: and complete-coverage behaviour is exactly as before (beta\'s counter-2 row expires)');

  const seenE: FakeQuery[] = [];
  const planE = await buildCatalogPlan(atsFake({ employers: empRows, supply: supRows, active: activeL }, seenE), fetchOf({ lever: [jobA1] }), { employerScopeEvidence: 'backstop-only' }, 'full', new RunContext());
  assert(planE.employerEvidence === 'backstop-only' && !seenE.some((q) => q.table === 'supply_sources'), 'backstop-only mode never reads timestamps (read-only tooling that blocks the adapters\' bookkeeping writes uses this)');
  assert(planE.unobservableScopes.some((s) => s.boardSlug === 'beta' && s.reason === 'zero-rows-with-active') && (planE.absence.get('lever')!.incrementByValue.get(1) ?? []).join() === 'a2', 'backstop-only: beta returned 0 rows while active => unobservable; alpha unaffected');

  let bkErr = '';
  try {
    await buildCatalogPlan(atsFake({ employers: empRows, supply: supRows, active: activeL }), fetchOf({ lever: [jobA1] }), { employerScopeEvidence: 'bookkeeping' }, 'full', new RunContext());
  } catch (e) {
    bkErr = (e as Error).message;
  }
  assert(/requires the fetch result to carry fetchStartedAt/.test(bkErr), 'forcing bookkeeping evidence without a fetch start time is a loud programming error, never a silent downgrade');
}
// ===========================================================================
const SRC_C = 'curated';
const SRC_R = 'remotive';

async function fingerprint(admin: ReturnType<typeof adminClient>, source: string, prefix: string) {
  const q = async (build: (b: any) => any) => {
    const r = await build(admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('source', source).not('source_id', 'like', `${prefix}%`));
    if (r.error) throw new Error(r.error.message);
    return r.count as number;
  };
  return JSON.stringify({
    total: await q((b) => b),
    active: await q((b) => b.eq('status', 'active')),
    expired: await q((b) => b.eq('status', 'expired')),
    abs1: await q((b) => b.eq('consecutive_absences', 1)),
    abs2: await q((b) => b.eq('consecutive_absences', 2)),
  });
}
async function countBy(admin: ReturnType<typeof adminClient>, source: string, prefix: string, f: (b: any) => any = (b) => b): Promise<number> {
  const r = await f(admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('source', source).like('source_id', `${prefix}%`));
  if (r.error) throw new Error(r.error.message);
  return r.count as number;
}
async function purge(admin: ReturnType<typeof adminClient>, source: string, prefix: string) {
  for (let i = 0; i < 40; i++) {
    const { data, error } = await admin.from('opportunities').select('id').eq('source', source).like('source_id', `${prefix}%`).limit(500);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return;
    await admin.from('opportunities').delete().in('id', data.map((r: any) => r.id));
  }
}
async function rowOf(admin: ReturnType<typeof adminClient>, source: string, sourceId: string) {
  const { data } = await admin.from('opportunities').select('*').eq('source', source).eq('source_id', sourceId).maybeSingle();
  return data as any;
}

async function section3RealInfra() {
  console.log('\n3. REAL INFRA — production Supabase, synthetic rows under test prefixes');
  if (!hasRequiredEnv()) {
    console.log('  (skipped: Supabase env not set)');
    return;
  }
  const admin = adminClient();
  const P = { scale: 'lc1b-scale-', odd: 'lc1b-odd-', win: 'lc1b-win-', dl: 'lc1b-dl-', par: 'lc1b-par-', shadow: 'lc1b-shadow-', leg: 'lc1b-leg-', ins: 'lc1b-ins-', wwr: 'lc1b-wwr-', unreg: 'lc1b-unreg-', lev: 'lever-spotify-lc1b-' };
  const SRC_L = 'lever';
  const SRC_W = 'weworkremotely';
  const SRC_U = 'lc1b-unregistered';
  const cleanupAll = async () => {
    for (const p of Object.values(P)) {
      await purge(admin, SRC_C, p);
      await purge(admin, SRC_R, p);
      await purge(admin, SRC_W, p);
      await purge(admin, SRC_U, p);
      await purge(admin, SRC_L, p);
    }
  };

  await cleanupAll();
  const residue = (await Promise.all(Object.values(P).flatMap((p) => [countBy(admin, SRC_C, p), countBy(admin, SRC_R, p), countBy(admin, SRC_W, p), countBy(admin, SRC_U, p), countBy(admin, SRC_L, p)]))).reduce((a, b) => a + b, 0);
  assert(residue === 0, 'no residue from a previous run');
  const fpC = await fingerprint(admin, SRC_C, 'lc1b-');
  const fpR = await fingerprint(admin, SRC_R, 'lc1b-');
  const fpW = await fingerprint(admin, SRC_W, 'lc1b-');
  const fpL = await fingerprint(admin, SRC_L, 'lever-spotify-lc1b-');

  try {
    const rollbacks: RollbackEntry[] = [];
    const sink = (e: RollbackEntry) => void rollbacks.push(e);
    const run = (mode: 'observe' | 'full' | 'legacy' | 'shadow', prefix: string, fr: ProviderFetchResult, extra: Record<string, unknown> = {}) =>
      syncOpportunitiesToCatalog(fr, { absenceScanSourceIdPrefix: prefix, mode, rollbackSink: sink, ...extra } as any);

    // ---------------------------------------------------------------- insert helper
    console.log('\n  3a. checked inserts');
    {
      const mk = (id: string, over: Record<string, unknown> = {}) => ({
        ...buildContentFields(norm({ sourceId: id, source: SRC_C as any })),
        source: SRC_C, source_id: id, type: norm({ sourceId: id, source: SRC_C as any }).type, status: 'active', posted_at: iso(H),
        first_seen_at: iso(H), last_seen_in_feed_at: iso(H), consecutive_absences: 0, ...over,
      });
      const first = await insertRowsIgnoringDuplicates(admin, [mk(`${P.ins}1`), mk(`${P.ins}2`)]);
      assert(first.inserted.length === 2 && first.conflicts === 0 && first.failed.length === 0, 'two fresh rows insert cleanly');
      const dup = await insertRowsIgnoringDuplicates(admin, [mk(`${P.ins}1`), mk(`${P.ins}2`), mk(`${P.ins}3`)]);
      assert(dup.inserted.length === 1 && dup.conflicts === 2 && dup.failed.length === 0, `2 existing keys are conflicts (not inserts, not errors); the 1 new row still lands (inserted=${dup.inserted.length}, conflicts=${dup.conflicts})`);
      const mixed = await insertRowsIgnoringDuplicates(admin, [mk(`${P.ins}4`), mk(`${P.ins}5`, { company: null }), mk(`${P.ins}6`)]);
      assert(mixed.inserted.length === 2 && mixed.failed.length === 1 && mixed.failed[0].message.length > 0, `a constraint-violating row is isolated and reported with the database message while its neighbours insert (inserted=${mixed.inserted.length}, failed=${mixed.failed.length})`, mixed.failed[0]?.message);
      assert((await countBy(admin, SRC_C, P.ins)) === 5, 'database holds exactly the 5 valid rows');
      await purge(admin, SRC_C, P.ins);
    }

    // ---------------------------------------------------------------- awkward ids
    console.log('\n  3b. awkward source_ids survive the targeted lookup');
    {
      const ids = ['a,b', 'x(y)', 'q"uote', 'sp ace/é', 'p%20ct', 'a&b=c', 'plus+sign', "sq'uote", 'back\\slash', '日本語'].map((s) => `${P.odd}${s}`);
      const jobs = ids.map((id) => raw({ sourceId: id, source: SRC_C as any }));
      const r1 = await run('full', P.odd, fetchOf({ [SRC_C]: jobs }));
      assert(r1.lifecycle!.inserts.written === ids.length && r1.lifecycle!.writeFailures === 0, `all ${ids.length} awkward ids insert`, JSON.stringify(r1.lifecycle!.errors));
      const r2 = await run('full', P.odd, fetchOf({ [SRC_C]: jobs }));
      assert(r2.lifecycle!.existingRowsResolved === ids.length && r2.lifecycle!.inserts.written === 0 && r2.lifecycle!.inserts.conflicts === 0,
        `re-run resolves every awkward id by key (resolved=${r2.lifecycle!.existingRowsResolved}, conflicts=${r2.lifecycle!.inserts.conflicts})`);
      assert(r2.lifecycle!.touched === ids.length && r2.lifecycle!.contentUpdated === 0, 'and treats them all as unchanged touches');
      await purge(admin, SRC_C, P.odd);
    }

    // ---------------------------------------------------------------- scale
    console.log('\n  3c. scale: 2,600 rows, past the 1,000-row PostgREST cap');
    {
      const N = 2600;
      const all = Array.from({ length: N }, (_, i) => raw({ sourceId: `${P.scale}${i}`, source: SRC_C as any, description: `Scale job ${i}. `.repeat(20), salaryMin: 1000 + i, salaryMax: 2000 + i }));
      const t0 = Date.now();
      const r1 = await run('observe', P.scale, fetchOf({ [SRC_C]: all }));
      const l1 = r1.lifecycle!;
      assert(l1.inserts.written === N && l1.inserts.conflicts === 0 && l1.writeFailures === 0, `first run inserts all ${N} rows (written=${l1.inserts.written}, failures=${l1.writeFailures})`, JSON.stringify(l1.errors));
      assert(r1.newJobsVerifiedActive === N, 'summary counters equal rows actually written');
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('status', 'active'))) === N, 'independent count: 2,600 active rows exist');
      console.log(`     (insert run: ${Date.now() - t0}ms, ${l1.requests} requests)`);

      const started = new Date().toISOString();
      const r2 = await run('full', P.scale, fetchOf({ [SRC_C]: all }));
      const l2 = r2.lifecycle!;
      const c2 = l2.bySource[SRC_C];
      assert(l2.existingRowsResolved === N, `re-run resolves all ${N} existing rows by key (resolved=${l2.existingRowsResolved}; the legacy read sees <=1000)`);
      assert(c2.activeScanned === N && c2.present === N, `absence scan reads ALL ${N} active rows (scanned=${c2.activeScanned}; legacy: <=1000)`);
      assert(l2.inserts.written === 0 && l2.inserts.conflicts === 0, 'no row is mistaken for new (0 inserts, 0 conflicts)');
      assert(l2.touched === N && l2.contentUpdated === 0, `all ${N} unchanged rows are bulk touches — full-content equality holds against the real database round-trip (touched=${l2.touched}, contentUpdated=${l2.contentUpdated})`);
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.gte('last_seen_in_feed_at', started))) === N, 'independent count: all 2,600 rows have last_seen advanced');
      console.log(`     (steady-state run: ${l2.durationMs}ms, ${l2.requests} requests; phases ${JSON.stringify(l2.phaseTimingsMs)})`);

      const keepHalf = all.slice(1300); // ids 1300..2599 present; 0..1299 absent
      const r3 = await run('full', P.scale, fetchOf({ [SRC_C]: keepHalf }));
      assert(r3.lifecycle!.bySource[SRC_C].incremented === 1300 && r3.lifecycle!.bySource[SRC_C].activeScanned === N, `1,300 absent rows are all counted, though only 1,000 could ever be read before (incremented=${r3.lifecycle!.bySource[SRC_C].incremented})`);
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('consecutive_absences', 1))) === 1300, 'independent count: exactly 1,300 rows at absences=1');
      assert(r3.absenceIncremented === 1300 && r3.expiredByAbsence === 0, 'summary matches');
      await run('full', P.scale, fetchOf({ [SRC_C]: keepHalf }));
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('consecutive_absences', 2))) === 1300, 'second absence: 1,300 rows at absences=2');

      const r5 = await run('full', P.scale, fetchOf({ [SRC_C]: keepHalf }));
      const c5 = r5.lifecycle!.bySource[SRC_C];
      assert(c5.held?.reason === 'limiter' && c5.held.planned === 1300 && c5.held.limit === 260 && c5.wouldExpire === 1300, `blast-radius limiter HOLDS 1,300 planned expiries (> max(200, 10% of 2,600 = 260)) (held=${JSON.stringify(c5.held)})`);
      assert(c5.expired === 0 && r5.expiredByAbsence === 0 && rollbacks.length === 0, 'nothing expired, nothing logged for rollback');
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('status', 'active'))) === N, 'independent count: all 2,600 rows still active');

      const r6 = await run('full', P.scale, fetchOf({ [SRC_C]: keepHalf }), { releaseExpiryLimiter: true });
      assert(r6.lifecycle!.bySource[SRC_C].expired === 1300 && r6.expiredByAbsence === 1300, 'released limiter: the 1,300 expire');
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('status', 'expired'))) === 1300 && (await countBy(admin, SRC_C, P.scale, (b) => b.eq('status', 'active'))) === 1300, 'independent count: 1,300 expired / 1,300 active');
      const logged = new Set(rollbacks.filter((e) => e.op === 'expire').flatMap((e) => e.ids));
      const { data: expRows } = await admin.from('opportunities').select('id').eq('source', SRC_C).like('source_id', `${P.scale}%`).eq('status', 'expired').limit(2000);
      assert(logged.size === 1300 && (expRows ?? []).every((r: any) => logged.has(r.id)), 'every expired id was logged for rollback BEFORE the write');

      const back = all.slice(1300).concat(all.slice(0, 100));
      const r7 = await run('full', P.scale, fetchOf({ [SRC_C]: back }));
      assert(r7.reappearedVerifiedActive === 100, `100 expired rows that reappear are refreshed and re-activated (reappearedVerifiedActive=${r7.reappearedVerifiedActive})`);
      assert((await countBy(admin, SRC_C, P.scale, (b) => b.eq('status', 'active'))) === 1400, 'independent count: 1,400 active');
      assert(r7.lifecycle!.writeFailures === 0 && r7.lifecycle!.errors.length === 0, 'no write failures across the whole scale sequence');
      await purge(admin, SRC_C, P.scale);
    }

    // ---------------------------------------------------------------- evidence-bounded absence
    console.log('\n  3d. windowed source: evidence-bounded absence, retirement, observe');
    {
      const job = (id: string, hoursAgo: number) => raw({ sourceId: `${P.win}${id}`, publicationDate: iso(hoursAgo * H) });
      const F = job('F', 1), A = job('A', 2), B = job('B', 10), C = job('C', 30), Dj = job('D', 60);
      const s1 = await run('full', P.win, fetchOf({ [SRC_R]: [F, A, B, C, Dj] }));
      assert(s1.lifecycle!.inserts.written === 5 && s1.newJobsVerifiedActive === 5, 'seed: 5 windowed rows inserted and verified active');
      const st = async (id: string) => rowOf(admin, SRC_R, `${P.win}${id}`);

      // window now covers only A,B (floor = B's postedAt = 10h): F is inside it and missing; C,D predate it.
      const r2 = await run('full', P.win, fetchOf({ [SRC_R]: [A, B] }));
      const w = r2.lifecycle!.bySource[SRC_R];
      assert(w.coverage === 'windowed' && w.floor === new Date(Date.parse(B.publicationDate)).toISOString(), 'floor = oldest postedAt fetched');
      assert((await st('F')).consecutive_absences === 1, 'F (inside the window, missing) accrues an absence');
      assert(w.unobservable === 2, `C and D (older than the window) are classified unobservable (unobservable=${w.unobservable})`);
      assert((await st('C')).consecutive_absences === 0 && (await st('D')).consecutive_absences === 0, 'and accrue NOTHING — a live job that merely slid out of the feed is not "removed"');
      await run('full', P.win, fetchOf({ [SRC_R]: [A, B] }));
      const r4 = await run('full', P.win, fetchOf({ [SRC_R]: [A, B] }));
      assert((await st('F')).status === 'expired' && r4.expiredByAbsence === 1, 'F expires on its 3rd absence');
      assert((await st('C')).status === 'active' && (await st('D')).status === 'active' && (await st('C')).consecutive_absences === 0, 'after 3 cycles C and D are still active with 0 absences (the naive rule would have expired both)');

      // retirement: C unseen for 8 days
      await admin.from('opportunities').update({ last_seen_in_feed_at: iso(8 * D) }).eq('source', SRC_R).eq('source_id', `${P.win}C`);
      const ro = await run('observe', P.win, fetchOf({ [SRC_R]: [A, B] }));
      assert((await st('C')).status === 'active' && ro.lifecycle!.bySource[SRC_R].wouldRetire === 1 && ro.lifecycle!.bySource[SRC_R].held?.reason === 'observe-mode', 'observe mode: retirement is planned and reported but NOT written');
      const rf = await run('full', P.win, fetchOf({ [SRC_R]: [A, B] }));
      assert((await st('C')).status === 'expired' && rf.lifecycle!.bySource[SRC_R].retired === 1, 'full mode: C (unobservable, unseen 8 days) is retired');
      assert((await st('D')).status === 'active', 'D (unobservable, seen recently) is untouched');
      assert(rollbacks.some((e) => e.op === 'retire' && e.ids.length === 1), 'the retirement was logged for rollback');
      await purge(admin, SRC_R, P.win);
    }

    // ---------------------------------------------------------------- deadline + fix H
    console.log('\n  3e. deadline bounds verification only; stuck unknown rows are re-verified');
    {
      const jobs = ['G', 'H'].map((x) => raw({ sourceId: `${P.dl}${x}` }));
      const r1 = await run('full', P.dl, fetchOf({ [SRC_R]: jobs }), { deadlineMs: -1 });
      assert(r1.lifecycle!.deadlineReached && r1.lifecycle!.verification.deferred === 2 && r1.lifecycle!.inserts.written === 2, 'a spent deadline defers verification but every insert still lands');
      assert((await rowOf(admin, SRC_R, `${P.dl}G`)).status === 'unknown', 'deferred rows are left unknown (invisible), not guessed');
      const r2 = await run('full', P.dl, fetchOf({ [SRC_R]: jobs }));
      assert(r2.lifecycle!.verification.requeuedUnknown === 2, 'FIX H: seeing the unknown rows again re-queues them');
      assert((await rowOf(admin, SRC_R, `${P.dl}G`)).status === 'active' && (await rowOf(admin, SRC_R, `${P.dl}H`)).status === 'active', 'and they resolve to active');

      // A windowed feed may never list a deferred row again — the backlog pickup must not depend on that.
      const stuck = ['I', 'J'].map((x) => raw({ sourceId: `${P.dl}${x}` }));
      await run('full', P.dl, fetchOf({ [SRC_R]: stuck }), { deadlineMs: -1 });
      assert((await rowOf(admin, SRC_R, `${P.dl}I`)).status === 'unknown', 'setup: two rows are stuck unknown');
      const filler = raw({ sourceId: `${P.dl}K`, publicationDate: iso(0.5 * H) });
      const r3 = await run('full', P.dl, fetchOf({ [SRC_R]: [filler] })); // the feed does NOT list I or J
      assert(r3.lifecycle!.verification.backlogQueued === 2 && r3.lifecycle!.verification.requeuedUnknown === 2, `unknown rows the feed did not list are still re-verified (backlogQueued=${r3.lifecycle!.verification.backlogQueued})`);
      assert((await rowOf(admin, SRC_R, `${P.dl}I`)).status === 'active' && (await rowOf(admin, SRC_R, `${P.dl}J`)).status === 'active', 'and resolve to active, with no feed sighting needed');
      await purge(admin, SRC_R, P.dl);
    }

    // ---------------------------------------------------------------- parity
    console.log('\n  3f. corrected path writes rows identical to the legacy path');
    {
      const rich = (id: string) => raw({ sourceId: id, title: 'Senior React Engineer', company: 'Parity Co', companyLogo: 'https://parity.invalid/logo.png', sourceUrl: 'https://parity.invalid/src', tags: ['react', 'typescript', 'node'], salaryMin: 90000, salaryMax: 140000, salaryCurrency: 'EUR', salaryPeriod: 'yearly', locationString: 'Worldwide', experienceLevel: 'Senior', publicationDate: iso(5 * H), description: 'We build remote-first products with React and TypeScript. Fully remote, worldwide. '.repeat(4) });
      // distinct company/title/url per side so within-run dedup cannot interact
      const L = rich(`${P.par}legacy`);
      const C = { ...rich(`${P.par}corrected`), officialUrl: 'https://lifecycle1b-suite.invalid/j/parity-corrected' };
      await run('legacy', P.par, fetchOf({ [SRC_R]: [L] }));
      // scoped to its own row so the absence pass cannot see the legacy row
      await run('full', `${P.par}corrected`, fetchOf({ [SRC_R]: [C] }));
      const rl = await rowOf(admin, SRC_R, L.sourceId);
      const rc = await rowOf(admin, SRC_R, C.sourceId);
      const cols = [...CONTENT_FIELD_NAMES, 'type', 'status', 'posted_at', 'consecutive_absences', 'link_reachable', 'is_permanently_removed'].filter((c) => !['official_url', 'canonical_url_hash'].includes(c));
      const diffs = cols.filter((c) => JSON.stringify(rl?.[c]) !== JSON.stringify(rc?.[c]));
      assert(!!rl && !!rc && diffs.length === 0, `legacy and corrected rows agree on ${cols.length} columns`, diffs.map((c) => `${c}: ${JSON.stringify(rl?.[c])} vs ${JSON.stringify(rc?.[c])}`).join(' | '));
      // the corrected path must read a LEGACY-written rich row (salary, skills, arrays) as unchanged
      const reread = await run('full', `${P.par}legacy`, fetchOf({ [SRC_R]: [L] }));
      assert(reread.lifecycle!.touched === 1 && reread.lifecycle!.contentUpdated === 0 && reread.lifecycle!.inserts.written === 0,
        `a legacy-written row round-trips as UNCHANGED under full-content comparison (touched=${reread.lifecycle!.touched}, contentUpdated=${reread.lifecycle!.contentUpdated})`);
      await purge(admin, SRC_R, P.par);
    }

    // ---------------------------------------------------------------- shadow
    console.log('\n  3g. shadow planner is read-only');
    {
      const jobs = Array.from({ length: 6 }, (_, i) => raw({ sourceId: `${P.shadow}${i}` }));
      await run('full', P.shadow, fetchOf({ [SRC_R]: jobs.slice(0, 3) })); // 3 exist
      const snap = async () => {
        const r = await admin.from('opportunities').select('id,status,consecutive_absences,last_seen_in_feed_at,link_checked_at').eq('source', SRC_R).like('source_id', `${P.shadow}%`).order('id');
        if (r.error || !r.data || r.data.length === 0) throw new Error(`snapshot read failed: ${r.error?.message ?? 'no rows'}`);
        return JSON.stringify(r.data);
      };
      const before = await snap();
      const rep = await planCatalogSyncReadOnly(fetchOf({ [SRC_R]: jobs }), { absenceScanSourceIdPrefix: P.shadow });
      assert(rep.mode === 'shadow' && rep.applied === false, 'report is marked plan-only');
      assert(rep.inserts.planned === 3 && rep.existingRowsResolved === 3, `plan: 3 new + 3 existing (planned=${rep.inserts.planned}, resolved=${rep.existingRowsResolved})`);
      assert((await snap()) === before && (await countBy(admin, SRC_R, P.shadow)) === 3, 'the planner changed nothing (rows, counters and timestamps identical; no inserts)');
      assert(rep.requests > 0 && rep.phaseTimingsMs.lookupExisting !== undefined, 'report carries request count and phase timings');

      const viaSync = await run('shadow', P.shadow, fetchOf({ [SRC_R]: jobs }));
      assert(viaSync.lifecycle?.applied === false && (await countBy(admin, SRC_R, P.shadow)) === 6, 'mode=shadow: legacy performs the real write (6 rows) while the plan is attached but unapplied');
      assert(viaSync.lifecycle!.inserts.planned === 3 && viaSync.newJobsVerifiedActive === 3, 'the plan (made first, on pre-write state) predicted the 3 inserts legacy then made');
      await purge(admin, SRC_R, P.shadow);
    }

    // ---------------------------------------------------------------- failed provider
    console.log('\n  3h. a failed provider is untouched');
    {
      const seed = raw({ sourceId: `${P.dl}fp`, source: SRC_R as any });
      await run('full', P.dl, fetchOf({ [SRC_R]: [seed] }));
      const before = await rowOf(admin, SRC_R, seed.sourceId);
      const rr = await run('full', P.dl, fetchOf({ [SRC_R]: 'fail', [SRC_C]: [] }));
      const after = await rowOf(admin, SRC_R, seed.sourceId);
      assert(!rr.lifecycle!.bySource[SRC_R] && JSON.stringify(before) === JSON.stringify(after), 'a provider that failed this cycle is not read for absence and its row is byte-identical afterwards');
      await purge(admin, SRC_R, P.dl);
    }

    // ---------------------------------------------------------------- legacy characterization
    console.log('\n  3i. characterization of the legacy defect (remove with the legacy path)');
    {
      const N = 1100;
      const all = Array.from({ length: N }, (_, i) => raw({ sourceId: `${P.leg}${i}`, source: SRC_C as any, description: `Legacy job ${i}. `.repeat(20) }));
      await run('legacy', P.leg, fetchOf({ [SRC_C]: all }));
      const before = await countBy(admin, SRC_C, P.leg);
      const again = await run('legacy', P.leg, fetchOf({ [SRC_C]: all }));
      const after = await countBy(admin, SRC_C, P.leg);
      assert(before === N && after === N, 'legacy run 2: database row count is unchanged (no duplicates possible)');
      assert(again.newJobsVerifiedActive > 0, `legacy run 2 nevertheless REPORTS ${again.newJobsVerifiedActive} "new" jobs: rows beyond the 1,000-row read are mistaken for new and their unique-violation inserts are swallowed — the defect this item fixes`);
      const fixed = await run('full', P.leg, fetchOf({ [SRC_C]: all }));
      assert(fixed.lifecycle!.inserts.written === 0 && fixed.lifecycle!.inserts.conflicts === 0 && fixed.newJobsVerifiedActive === 0, 'the corrected path on identical data reports 0 new jobs');
      await purge(admin, SRC_C, P.leg);
    }

    // ---------------------------------------------------------------- v2: WWR exempt
    console.log('\n  3j. v2: weworkremotely is EXEMPT from absence expiry (real rows are scoped out by prefix)');
    {
      const w = (id: string) => raw({ sourceId: `${P.wwr}${id}`, source: SRC_W as any, publicationDate: iso(2 * H) });
      const [A, B, C] = [w('A'), w('B'), w('C')];
      const s1 = await run('full', P.wwr, fetchOf({ [SRC_W]: [A, B, C] }));
      assert(s1.lifecycle!.inserts.written === 3 && s1.lifecycle!.bySource[SRC_W].coverage === 'exempt', 'seed: 3 WWR rows inserted; policy reported as exempt');
      const st = async (id: string) => rowOf(admin, SRC_W, `${P.wwr}${id}`);
      let last: any;
      for (let i = 0; i < 4; i++) last = await run('full', P.wwr, fetchOf({ [SRC_W]: [A] })); // B and C absent x4 (legacy rule: expired at the 3rd)
      const wl = last.lifecycle!.bySource[SRC_W];
      assert((await st('B')).status === 'active' && (await st('B')).consecutive_absences === 0 && (await st('C')).status === 'active', 'B and C stay ACTIVE with 0 absences after 4 cycles absent (the legacy rule would have expired both at cycle 3)');
      assert(wl.incremented === 0 && wl.expired === 0 && wl.unobservable === 2 && last.expiredByAbsence === 0, `no absence is ever counted (incremented=${wl.incremented}, expired=${wl.expired}, unobservable=${wl.unobservable})`);
      await admin.from('opportunities').update({ last_seen_in_feed_at: iso(8 * D) }).eq('source', SRC_W).eq('source_id', `${P.wwr}C`);
      const ro = await run('observe', P.wwr, fetchOf({ [SRC_W]: [A] }));
      assert((await st('C')).status === 'active' && ro.lifecycle!.bySource[SRC_W].wouldRetire === 1, 'observe: a WWR row unseen 8 days is planned for retirement but NOT written');
      const rf = await run('full', P.wwr, fetchOf({ [SRC_W]: [A] }));
      assert((await st('C')).status === 'expired' && rf.lifecycle!.bySource[SRC_W].retired === 1 && (await st('B')).status === 'active', 'full: only C (unseen > 7d) is retired; B (absent but recently seen) is untouched');
      await purge(admin, SRC_W, P.wwr);
    }

    // ---------------------------------------------------------------- v2: unregistered source
    console.log('\n  3k. v2: a source missing from supply_platforms is skipped and reported, not attempted');
    {
      const u = [1, 2, 3].map((i) => raw({ sourceId: `${P.unreg}${i}`, source: SRC_U as any }));
      const good = raw({ sourceId: `${P.unreg}good` });
      const r = await run('full', P.unreg, fetchOf({ [SRC_R]: [good], [SRC_U]: u }));
      const l = r.lifecycle!;
      assert(JSON.stringify(l.unregisteredSources) === JSON.stringify([{ source: SRC_U, fetched: 3, skippedInserts: 3 }]), 'reported in unregisteredSources', JSON.stringify(l.unregisteredSources));
      assert(l.inserts.planned === 1 && l.inserts.written === 1 && l.inserts.conflicts === 0, 'only the registered source\'s row is planned/inserted — no doomed FK-violating chunk, no row-by-row retries');
      assert(l.verification.queued === 1 && l.writeFailures === 0, 'no verification slot is spent on the unregistered source, and it is not a write failure');
      assert(l.errors.some((e) => e.op === `unregistered-source(${SRC_U})`), 'errors[] carries it, so it can never read as healthy');
      assert(!l.bySource[SRC_U] && (await countBy(admin, SRC_U, P.unreg)) === 0, 'nothing was read or stored for it');
      assert((await rowOf(admin, SRC_R, `${P.unreg}good`)).status === 'active', 'the registered source in the same run is unaffected');
      await purge(admin, SRC_R, P.unreg);
    }

    // ---------------------------------------------------------------- v2.1: registry parity
    console.log('\n  3l. v2.1: the applier\'s employer read agrees with getApprovedEmployers() on production data');
    for (const provider of ['greenhouse', 'lever', 'ashby'] as const) {
      const mine = (await readApprovedEmployers(admin, provider)).map((e) => `${e.boardSlug}|${e.linkedSourceId}`).sort();
      const theirs = (await getApprovedEmployers(provider)).map((e) => `${e.boardSlug}|${e.linkedSourceId}`).sort();
      assert(mine.length > 0 && JSON.stringify(mine) === JSON.stringify(theirs), `${provider}: the same ${mine.length} employers, board slugs and linked sources`);
    }

    // ---------------------------------------------------------------- v2.1: rule L end-to-end
    console.log('\n  3m. v2.1 rule L end-to-end: REAL registry + REAL supply_sources bookkeeping, synthetic Spotify rows (prefix-scoped)');
    {
      const spot = (await readApprovedEmployers(admin, SRC_L)).find((e) => e.boardSlug === 'spotify');
      const ss: any = spot?.linkedSourceId ? await admin.from('supply_sources').select('last_successful_fetch_at').eq('id', spot.linkedSourceId).maybeSingle() : null;
      if (!spot || !ss?.data?.last_successful_fetch_at) {
        console.log('  (skipped: no approved Spotify employer with a recorded successful fetch)');
      } else {
        const lj = (id: string) => raw({ sourceId: `${P.lev}${id}`, source: SRC_L as any, publicationDate: iso(H), locationString: 'Worldwide' });
        const [A, B, C] = [lj('A'), lj('B'), lj('C')];
        const st = async (id: string) => rowOf(admin, SRC_L, `${P.lev}${id}`);
        const FUTURE = Date.now() + 3_600_000; // no employer can have a success stamped this late => "not proven fetched"
        const seed = async () => run('full', P.lev, fetchOf({ [SRC_L]: [A, B, C] }));

        const s1 = await seed();
        assert(s1.lifecycle!.inserts.written === 3 && s1.lifecycle!.employerEvidence === 'off', 'seed: 3 synthetic Spotify rows inserted; an injected fetch leaves rule L off');

        // (i) employer NOT proven fetched this run => its rows never accrue absence
        let last: any;
        for (let i = 0; i < 4; i++) last = await run('full', P.lev, fetchOf({ [SRC_L]: [A] }, FUTURE));
        const l1 = last.lifecycle!;
        assert(l1.employerEvidence === 'bookkeeping' && l1.unobservableScopes.some((s: any) => s.boardSlug === 'spotify' && s.reason === 'not-attempted' && s.activeRows === 3), 'unproven employer reported by name with reason not-attempted', JSON.stringify(l1.unobservableScopes.filter((s: any) => s.boardSlug === 'spotify')));
        assert((await st('B')).status === 'active' && (await st('B')).consecutive_absences === 0 && (await st('C')).status === 'active' && last.expiredByAbsence === 0, 'B and C survive 4 cycles absent with 0 absences (legacy: expired at cycle 3) — a failed/unproven employer cannot lose its rows');
        assert(l1.bySource[SRC_L].employerScopes.unobservable >= 1, 'the per-source employerScopes summary counts it');

        // (ii) employer PROVEN fetched (start = epoch) => ordinary complete-coverage absence, expiry at the 3rd
        for (let i = 0; i < 2; i++) await run('full', P.lev, fetchOf({ [SRC_L]: [A] }, 1));
        assert((await st('B')).consecutive_absences === 2 && (await st('B')).status === 'active', 'proven employer: B is absence-counted normally (2 after 2 cycles)');
        const r3 = await run('full', P.lev, fetchOf({ [SRC_L]: [A] }, 1));
        assert((await st('B')).status === 'expired' && (await st('C')).status === 'expired' && r3.expiredByAbsence === 2 && (await st('A')).status === 'active', 'proven employer: B and C expire on the 3rd absence; the present row A is untouched');
        await purge(admin, SRC_L, P.lev);

        // (iii) backstop: bookkeeping says fetched, but ZERO rows came back while 3 are active
        await seed();
        const rb = await run('full', P.lev, fetchOf({ [SRC_L]: [] }, 1));
        assert(rb.lifecycle!.unobservableScopes.some((s: any) => s.boardSlug === 'spotify' && s.reason === 'zero-rows-with-active' && s.activeRows === 3), 'backstop: an employer returning 0 rows while it has active rows is unobservable even with success bookkeeping');
        assert((await st('A')).consecutive_absences === 0 && (await st('B')).consecutive_absences === 0 && (await st('C')).status === 'active', 'and none of its 3 rows gained an absence');

        // (iv) retirement still applies to an unobservable scope
        await admin.from('opportunities').update({ last_seen_in_feed_at: iso(8 * D) }).eq('source', SRC_L).eq('source_id', `${P.lev}C`);
        const ro = await run('observe', P.lev, fetchOf({ [SRC_L]: [A] }, FUTURE));
        assert((await st('C')).status === 'active' && ro.lifecycle!.bySource[SRC_L].wouldRetire === 1, 'observe: the unseen-8-days row of an unproven employer is planned for retirement but not written');
        const rf = await run('full', P.lev, fetchOf({ [SRC_L]: [A] }, FUTURE));
        assert((await st('C')).status === 'expired' && rf.lifecycle!.bySource[SRC_L].retired === 1 && (await st('B')).status === 'active', 'full: only C (unseen > 7d) is retired; B (absent but recently seen) is untouched');
        await purge(admin, SRC_L, P.lev);
      }
    }

    // ---------------------------------------------------------------- v2.1: windowHours / gapRisk
    console.log('\n  3n. v2.1 D-N5: windowHours / gapRisk are reported by the (read-only) plan');
    {
      const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
      const mk = (id: string, h: number) => raw({ sourceId: `lc1b-gap-${id}`, publicationDate: ago(h) });
      const near = (x: number | null, y: number, tol = 0.1) => x !== null && Math.abs(x - y) < tol;
      const narrow = (await planCatalogSyncReadOnly(fetchOf({ [SRC_R]: [mk('a', 2), mk('b', 5)] }), { absenceScanSourceIdPrefix: 'lc1b-gap-' })).bySource[SRC_R];
      assert(near(narrow.windowHours, 5) && near(narrow.newestAgeHours, 2) && near(narrow.gapMarginHours, -3) && narrow.gapRisk === true, `a 5h window with a 2h-old newest posting cannot cover a 6h cadence => gapRisk (${narrow.windowHours}h, newest ${narrow.newestAgeHours}h, margin ${narrow.gapMarginHours}h)`);
      const widePlan = await planCatalogSyncReadOnly(fetchOf({ [SRC_R]: [mk('c', 1), mk('d', 40)] }), { absenceScanSourceIdPrefix: 'lc1b-gap-' });
      const wide = widePlan.bySource[SRC_R];
      assert(near(wide.windowHours, 40) && near(wide.gapMarginHours, 33) && wide.gapRisk === false && !widePlan.gapRiskSources.includes(SRC_R), 'a 40h window => margin +33h, no gap risk, and the source is not in gapRiskSources');
      const narrowPlan = await planCatalogSyncReadOnly(fetchOf({ [SRC_R]: [mk('e', 2), mk('f', 5)] }), { absenceScanSourceIdPrefix: 'lc1b-gap-' });
      assert(narrowPlan.gapRiskSources.includes(SRC_R), 'gapRiskSources lists the narrow-window source at report level');
      const nonWin = await planCatalogSyncReadOnly(fetchOf({ [SRC_C]: [raw({ sourceId: 'lc1b-gap-cur', source: SRC_C as any })], [SRC_W]: [raw({ sourceId: 'lc1b-gap-wwr', source: SRC_W as any })] }), { absenceScanSourceIdPrefix: 'lc1b-gap-' });
      assert([SRC_C, SRC_W].every((s) => nonWin.bySource[s].windowHours === null && nonWin.bySource[s].gapRisk === false), 'complete (curated) and exempt (WWR) sources report windowHours null and gapRisk false');
      assert((await countBy(admin, SRC_R, 'lc1b-gap-')) === 0 && (await countBy(admin, SRC_C, 'lc1b-gap-')) === 0 && (await countBy(admin, SRC_W, 'lc1b-gap-')) === 0, 'the read-only plan stored nothing');
    }
  } finally {
    await cleanupAll();
  }

  const left = (await Promise.all(Object.values(P).flatMap((p) => [countBy(admin, SRC_C, p), countBy(admin, SRC_R, p), countBy(admin, SRC_W, p), countBy(admin, SRC_U, p), countBy(admin, SRC_L, p)]))).reduce((a, b) => a + b, 0);
  assert(left === 0, 'cleanup: zero synthetic rows remain');
  assert((await fingerprint(admin, SRC_C, 'lc1b-')) === fpC, 'real curated rows untouched (fingerprint identical)');
  assert((await fingerprint(admin, SRC_R, 'lc1b-')) === fpR, 'real remotive rows untouched (fingerprint identical)');
  assert((await fingerprint(admin, SRC_W, 'lc1b-')) === fpW, 'real weworkremotely rows untouched (fingerprint identical)');
  assert((await fingerprint(admin, SRC_L, 'lever-spotify-lc1b-')) === fpL, 'real lever rows untouched (fingerprint identical)');
}

async function main() {
  console.log('='.repeat(78));
  console.log('PHASE A ITEM 1b — CATALOG-SYNC LIFECYCLE SUITE');
  console.log('='.repeat(78));
  await section0Static();
  await section1Planner();
  await section2Failures();
  await section3RealInfra();
  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(1);
});
