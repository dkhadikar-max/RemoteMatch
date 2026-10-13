/**
 * RemoteMatch — catalog-sync lifecycle APPLIER (Phase A, Item 1b)
 * ==============================================================================
 * The only code that executes a plan from catalog-sync-plan.ts. Three modes
 * reach it (the dispatcher in catalog-sync.ts chooses; `legacy` never does):
 *   shadow  — buildCatalogPlan() only. READ-ONLY: reads + planning, zero writes.
 *   observe — applies everything, but withholds every expiry/retirement.
 *   full    — applies everything, expiry gated by the blast-radius limiter.
 *
 * Properties this file exists to guarantee (docs/phase-a-item-1b-spec.md):
 *  - Complete reads: existing rows are resolved by KEY (never a truncated
 *    slice), the absence scan is keyset-paged, so nothing hides behind
 *    PostgREST's silent 1,000-row cap.
 *  - No swallowed errors: every read and write is error-checked. A lookup
 *    failure aborts the run BEFORE any write; a write failure is counted and
 *    itemised in the report, never reported as a success.
 *  - Bounded cost: writes are bulk (`.in('id', chunk)`), inserts are one
 *    race-safe upsert(ignoreDuplicates) per chunk, link verification runs with
 *    bounded concurrency under a run deadline, and is the ONLY phase that can
 *    be cut short (rows left 'unknown' are re-queued next cycle — FIX H).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { fetchAllRows, QueryError } from '@/lib/supabase/query-helpers';
import { normalizeOpportunity, deduplicateOpportunities, verifyLinkFreshness } from './pipeline';
import { passesFreshnessGate } from './freshness-gate';
import { TRANSLATION_STATE_COLUMNS, needsOriginalText, loadOriginalTexts } from './translation-preservation';
import type { ProviderFetchResult, SyncSummary, SyncOptions } from './catalog-sync';
import {
  ATS_EMPLOYER_SOURCES,
  CONTENT_FIELD_NAMES,
  DEFAULT_RETIREMENT_DAYS,
  buildScopeGate,
  classifyEmployerScopes,
  computeSourceCoverage,
  isGateRejected,
  planAbsence,
  planUpserts,
  scopeSlugFor,
  windowMetrics,
  type EmployerScopeInfo,
  type ScopeGate,
  type UnobservableScope,
  type AbsencePlan,
  type ActiveScanRow,
  type ExistingRow,
  type InsertKind,
  type LifecycleError,
  type LifecycleReport,
  type NormalizedOpp,
  type PlannedInsert,
  type SourceCoverage,
  type SourceLifecycle,
  type SyncMode,
  type UpsertPlan,
} from './catalog-sync-plan';

const ABSENCE_EXPIRY_THRESHOLD = 3;
const WEAK_DESCRIPTION_MIN_LENGTH = 100;
const ATS_SOURCES_WITH_FRESHNESS_GATE: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby']);

const DEFAULT_DEADLINE_MS = 240_000; // of the 300s cron window (spec §4.3)
const LOOKUP_MAX_KEYS = 150;
const LOOKUP_MAX_ENCODED_CHARS = 3_500; // keep request URLs well under gateway limits
const ID_CHUNK = 100; // uuid list in a URL: 100 x ~37 chars
const INSERT_CHUNK = 100;
const DB_CONCURRENCY = 4;
const UPDATE_CONCURRENCY = 6;
const VERIFY_CONCURRENCY = 8;

const EXISTING_COLUMNS = ['id', 'source', 'source_id', 'status', 'consecutive_absences', 'posted_at', ...CONTENT_FIELD_NAMES, ...TRANSLATION_STATE_COLUMNS].join(', ');
const ACTIVE_SCAN_COLUMNS = 'id, source_id, consecutive_absences, posted_at, last_seen_in_feed_at, first_seen_at';

type Admin = SupabaseClient;

export interface RollbackEntry {
  runAt: string;
  op: 'expire' | 'retire';
  source: string;
  ids: string[];
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Splits keys into chunks bounded by both count and encoded URL length. */
function chunkByBudget(keys: readonly string[], maxCount: number, maxEncodedChars: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const key of keys) {
    const cost = encodeURIComponent(key).length + 3; // quotes + comma
    if (cur.length > 0 && (cur.length >= maxCount || curChars + cost > maxEncodedChars)) {
      out.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(key);
    curChars += cost;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Runs `fn` over items with bounded concurrency. The first thrown error stops
 *  further work and is re-thrown. `shouldStop` lets a phase stop STARTING new
 *  items (deadline) without failing. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  const worker = async () => {
    while (firstError === null && next < items.length) {
      if (shouldStop?.()) return;
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        if (firstError === null) firstError = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  if (firstError !== null) throw firstError;
}

export class RunContext {
  requests = 0;
  writeFailures = 0;
  private readonly errorMap = new Map<string, LifecycleError>();
  readonly phaseTimingsMs: Record<string, number> = {};

  recordError(op: string, err: { message: string; code?: string } | string, rows: number, countAsWriteFailure = true): void {
    const message = typeof err === 'string' ? err : err.message;
    const code = typeof err === 'string' ? undefined : err.code;
    const existing = this.errorMap.get(op);
    if (existing) existing.count += rows;
    else this.errorMap.set(op, { op, count: rows, sample: message.slice(0, 300), ...(code ? { code } : {}) });
    if (countAsWriteFailure) this.writeFailures += rows;
  }

  get errors(): LifecycleError[] {
    return Array.from(this.errorMap.values());
  }

  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.phaseTimingsMs[name] = (this.phaseTimingsMs[name] ?? 0) + (Date.now() - t0);
    }
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function loadExistingRows(admin: Admin, keysBySource: ReadonlyMap<string, string[]>, ctx: RunContext): Promise<ExistingRow[]> {
  const tasks: { source: string; ids: string[] }[] = [];
  for (const [source, ids] of Array.from(keysBySource.entries())) {
    for (const ids_ of chunkByBudget(ids, LOOKUP_MAX_KEYS, LOOKUP_MAX_ENCODED_CHARS)) tasks.push({ source, ids: ids_ });
  }
  const out: ExistingRow[] = [];
  await runPool(tasks, DB_CONCURRENCY, async (t) => {
    ctx.requests++;
    const res = await admin.from('opportunities').select(EXISTING_COLUMNS).eq('source', t.source).in('source_id', t.ids);
    if (res.error) throw new QueryError(`existing-row lookup (${t.source})`, res.error.message, res.error.code);
    out.push(...((res.data ?? []) as unknown as ExistingRow[]));
  });
  // Translated rows keep their translation unless the SOURCE text really changed (translation-preservation.ts).
  // That is decided by an exact comparison with the stored source text, loaded for translated rows only.
  const needing = out.filter((r) => needsOriginalText(r)).map((r) => r.id);
  if (needing.length > 0) {
    const { byId, requests } = await loadOriginalTexts(admin, needing);
    ctx.requests += requests;
    for (const r of out) {
      const o = byId.get(r.id);
      if (o) { r.original_title = o.original_title; r.original_description = o.original_description; }
    }
  }
  return out;
}

async function loadActiveRows(admin: Admin, source: string, prefix: string | undefined, ctx: RunContext): Promise<ActiveScanRow[]> {
  const rows = await fetchAllRows<ActiveScanRow>(
    (afterId, size) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = admin
        .from('opportunities')
        .select(ACTIVE_SCAN_COLUMNS)
        .eq('source', source)
        .eq('status', 'active')
        .order('id', { ascending: true })
        .limit(size);
      if (prefix) q = q.like('source_id', `${prefix}%`);
      if (afterId) q = q.gt('id', afterId);
      return q;
    },
    { label: `active rows (${source})` }
  );
  ctx.requests += Math.floor(rows.length / 1000) + 1;
  return rows;
}

// ---------------------------------------------------------------------------
// plan construction (READ-ONLY)
// ---------------------------------------------------------------------------

export interface CatalogPlan {
  nowIso: string;
  upserts: UpsertPlan;
  absence: Map<string, AbsencePlan>;
  coverage: Map<string, SourceCoverage>;
  fetchedBySource: Map<string, number>;
  keysLookedUpBySource: Map<string, number>;
  existingRowsResolved: number;
  absenceScanErrors: Map<string, string>;
  /** unknown rows re-queued for verification although the feed did not list them */
  unknownBacklogQueued: number;
  /** Fetched sources absent from supply_platforms: skipped entirely, reported (spec v2 §2 B). */
  unregistered: { source: string; fetched: number; skippedInserts: number }[];
  /** keys the C3 gate rejected, so never looked up (spec v2 §2 C); still counted present */
  lookupsSkippedByGate: number;
  /** spec v2.1 rule L: how the employer-scope evidence was gathered this run */
  employerEvidence: 'bookkeeping' | 'backstop-only' | 'off';
  employerScopes: Map<string, { observable: number; unobservable: number; unobservableRows: number }>;
  unobservableScopes: UnobservableScope[];
}

/** The platform registry `opportunities.source` has a FOREIGN KEY to
 *  (012_supply_discovery_registry.sql:230). Read once per run; a failure aborts
 *  the run before any write, like every other read. */
async function loadRegisteredPlatforms(admin: Admin, ctx: RunContext): Promise<Set<string>> {
  ctx.requests++;
  const res = await admin.from('supply_platforms').select('slug');
  if (res.error) throw new QueryError('platform registry read', res.error.message, res.error.code);
  return new Set(((res.data ?? []) as { slug: string }[]).map((r) => r.slug));
}

export interface ApprovedEmployerScope {
  canonicalName: string;
  boardSlug: string;
  linkedSourceId: string | null;
}

/**
 * The approved employers of one ATS provider — the SAME select and board-slug rule as
 * employer-registry.ts `getApprovedEmployers()` (a test asserts they agree on production data), but
 * read through the run's own client and, crucially, THROWING on a database error: getApprovedEmployers
 * returns [] on error, which here would be indistinguishable from "no employers" (spec v2.1 rule L.5).
 */
export async function readApprovedEmployers(admin: Admin, provider: string, ctx?: { requests: number }): Promise<ApprovedEmployerScope[]> {
  if (ctx) ctx.requests++;
  const res = await admin
    .from('allowlist_employers')
    .select('id, canonical_name, career_url, linked_source_id')
    .eq('ats_provider', provider)
    .eq('review_status', 'approved');
  if (res.error) throw new QueryError(`employer registry read (${provider})`, res.error.message, res.error.code);
  const out: ApprovedEmployerScope[] = [];
  for (const row of (res.data ?? []) as { canonical_name: string; career_url: string | null; linked_source_id: string | null }[]) {
    const slugMatch = row.career_url?.match(/([a-zA-Z0-9_-]+)\/?$/);
    if (!slugMatch) continue; // same skip as getApprovedEmployers
    out.push({ canonicalName: row.canonical_name, boardSlug: slugMatch[1], linkedSourceId: row.linked_source_id });
  }
  return out;
}

/** Employers + the per-employer bookkeeping the adapters write (`last_successful_fetch_at` on success only). */
async function loadEmployerScopeInfo(admin: Admin, provider: string, ctx: RunContext, withBookkeeping: boolean): Promise<EmployerScopeInfo[]> {
  const employers = await readApprovedEmployers(admin, provider, ctx);
  // backstop-only mode never looks at timestamps, so the bookkeeping read is skipped
  const linked = withBookkeeping ? Array.from(new Set(employers.map((e) => e.linkedSourceId).filter((x): x is string => x !== null))) : [];
  const stamps = new Map<string, { success: number | null; attempt: number | null }>();
  for (const ids of chunk(linked, ID_CHUNK)) {
    ctx.requests++;
    const res = await admin.from('supply_sources').select('id, last_successful_fetch_at, last_fetch_attempt_at').in('id', ids);
    if (res.error) throw new QueryError(`employer bookkeeping read (${provider})`, res.error.message, res.error.code);
    for (const r of (res.data ?? []) as { id: string; last_successful_fetch_at: string | null; last_fetch_attempt_at: string | null }[]) {
      stamps.set(r.id, {
        success: r.last_successful_fetch_at ? Date.parse(r.last_successful_fetch_at) : null,
        attempt: r.last_fetch_attempt_at ? Date.parse(r.last_fetch_attempt_at) : null,
      });
    }
  }
  return employers.map((e) => {
    const s = e.linkedSourceId ? stamps.get(e.linkedSourceId) : undefined;
    return {
      boardSlug: e.boardSlug,
      linkedSourceId: e.linkedSourceId,
      lastSuccessMs: s && s.success !== null && !Number.isNaN(s.success) ? s.success : null,
      lastAttemptMs: s && s.attempt !== null && !Number.isNaN(s.attempt) ? s.attempt : null,
    };
  });
}

/** Rule L is ON only with evidence: real runs carry `fetchStartedAt` (set by the dispatcher); injected
 *  test fetches do not, so their complete-coverage behaviour is unchanged. `backstop-only` (used by
 *  read-only tooling that blocks the adapters' bookkeeping writes) skips the timestamp evidence. */
function resolveEmployerEvidence(fetchResult: ProviderFetchResult, options?: SyncOptions): 'bookkeeping' | 'backstop-only' | 'off' {
  const requested = options?.employerScopeEvidence;
  if (requested === 'bookkeeping' && fetchResult.fetchStartedAt === undefined) {
    throw new Error('employerScopeEvidence "bookkeeping" requires the fetch result to carry fetchStartedAt');
  }
  return requested ?? (fetchResult.fetchStartedAt !== undefined ? 'bookkeeping' : 'off');
}

function resolveRetirementDays(options?: SyncOptions): number | null {
  if (options && 'retirementDays' in options && options.retirementDays !== undefined) return options.retirementDays;
  const env = process.env.CATALOG_SYNC_RETIREMENT_DAYS;
  if (env === undefined || env.trim() === '') return DEFAULT_RETIREMENT_DAYS;
  if (/^(off|none|disabled)$/i.test(env.trim())) return null;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETIREMENT_DAYS;
}

function resolveReleaseLimiter(options?: SyncOptions): boolean {
  return options?.releaseExpiryLimiter ?? process.env.CATALOG_SYNC_RELEASE_LIMITER === '1';
}

function resolveDeadlineMs(options?: SyncOptions): number {
  if (options?.deadlineMs !== undefined) return options.deadlineMs;
  const n = Number(process.env.CATALOG_SYNC_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEADLINE_MS;
}

/**
 * Reads what the plan needs and decides what to write. Performs NO writes.
 * Throws (before any write is possible) if the existing-row lookup fails.
 * A failed absence scan for one source is recorded and that source's absence
 * pass is skipped — fail-closed: no partial absence accounting, ever.
 */
export async function buildCatalogPlan(
  admin: Admin,
  fetchResult: ProviderFetchResult,
  options: SyncOptions | undefined,
  mode: SyncMode,
  ctx: RunContext
): Promise<CatalogPlan> {
  const nowIso = new Date().toISOString();
  const fetchedSources = fetchResult.outcomes.filter((o) => o.success).map((o) => o.sourceKey);
  const employerEvidence = resolveEmployerEvidence(fetchResult, options);

  // 0. Registry pre-flight (spec v2 §2 B). A source that is not in
  // supply_platforms can never be stored (FK), so it is neither looked up,
  // inserted, verified nor absence-scanned — it is REPORTED, every run.
  const registered = await ctx.phase('registryPreflight', () => loadRegisteredPlatforms(admin, ctx));
  const successfulSources = fetchedSources.filter((s) => registered.has(s));

  const allRaw = fetchedSources.flatMap((s) => fetchResult.successfulRaw.get(s) ?? []);
  const overrides = new Map<string, { isPermanentlyRemoved: boolean }>();
  for (const raw of allRaw) {
    if (raw.status === 'EXPIRED') overrides.set(`${raw.source}:${raw.sourceId}`, { isPermanentlyRemoved: Boolean(raw.isPermanentlyRemoved) });
  }

  const normalized = allRaw.map(normalizeOpportunity).filter((o) => o.title && o.company);
  const dedupedAll = deduplicateOpportunities(normalized) as NormalizedOpp[];
  const unregistered = fetchedSources
    .filter((s) => !registered.has(s))
    .map((source) => {
      const fetched = dedupedAll.filter((o) => o.source === source).length;
      return { source, fetched, skippedInserts: fetched };
    });
  const deduped = dedupedAll.filter((o) => registered.has(o.source));
  for (const u of unregistered) {
    // Loud, cheap, and NOT counted as a write failure (nothing was attempted).
    ctx.recordError(
      `unregistered-source(${u.source})`,
      `source "${u.source}" is not in supply_platforms (opportunities.source FK) — ${u.fetched} fetched job(s) cannot be stored and were not attempted`,
      u.fetched,
      false
    );
  }

  const oppsBySource = new Map<string, NormalizedOpp[]>();
  const presentBySource = new Map<string, Set<string>>();
  for (const s of successfulSources) {
    oppsBySource.set(s, []);
    presentBySource.set(s, new Set());
  }
  for (const opp of deduped) {
    oppsBySource.get(opp.source)?.push(opp);
    presentBySource.get(opp.source)?.add(opp.sourceId);
  }
  const coverage = computeSourceCoverage(oppsBySource, successfulSources);

  // 1. Existing rows, resolved by KEY for the jobs this cycle fetched — minus
  // candidates the C3 gate will reject (spec v2 §2 C): they are `continue`d
  // before any write, so their existing row is never needed. They are still in
  // `presentBySource`, so they are still "present" for absence purposes.
  const gatePolicy = { atsGated: ATS_SOURCES_WITH_FRESHNESS_GATE, passesFreshness: passesFreshnessGate };
  let lookupsSkippedByGate = 0;
  const keysBySource = new Map<string, string[]>();
  for (const [source, opps] of Array.from(oppsBySource.entries())) {
    const needed = opps.filter((o) => !isGateRejected(o, gatePolicy));
    lookupsSkippedByGate += opps.length - needed.length;
    keysBySource.set(source, needed.map((o) => o.sourceId));
  }
  const existingRows = await ctx.phase('lookupExisting', () => loadExistingRows(admin, keysBySource, ctx));
  const existingByKey = new Map<string, ExistingRow>(existingRows.map((r) => [`${r.source}:${r.source_id}`, r]));

  // 2. What to write for the jobs the feed returned.
  const upserts = await ctx.phase('planUpserts', async () =>
    planUpserts(deduped, existingByKey, overrides, {
      now: nowIso,
      atsGated: ATS_SOURCES_WITH_FRESHNESS_GATE,
      passesFreshness: passesFreshnessGate,
      isWeakDescription: (d) => (d || '').trim().length < WEAK_DESCRIPTION_MIN_LENGTH,
      skipsVerification: (s) => s === 'curated',
    })
  );

  // 3. Absence accounting, per successful source, over a COMPLETE active scan.
  const absence = new Map<string, AbsencePlan>();
  const absenceScanErrors = new Map<string, string>();
  const policy = {
    threshold: ABSENCE_EXPIRY_THRESHOLD,
    retirementDays: resolveRetirementDays(options),
    nowMs: Date.now(),
    withholdExpiry: mode === 'observe',
    releaseLimiter: resolveReleaseLimiter(options),
  };
  const employerScopes = new Map<string, { observable: number; unobservable: number; unobservableRows: number }>();
  const unobservableScopes: UnobservableScope[] = [];
  await ctx.phase('absenceScan', async () => {
    for (const source of successfulSources) {
      let stage = 'absence-scan';
      try {
        const rows = await loadActiveRows(admin, source, options?.absenceScanSourceIdPrefix, ctx);

        // Rule L (spec v2.1): a complete-coverage ATS source may only count an absence for an employer
        // board that was positively shown to have been fetched this cycle.
        let gate: ScopeGate | undefined;
        if (employerEvidence !== 'off' && ATS_EMPLOYER_SOURCES.has(source)) {
          stage = 'employer-evidence';
          const employers = await loadEmployerScopeInfo(admin, source, ctx, employerEvidence === 'bookkeeping');
          const slugs = employers.map((e) => e.boardSlug);
          const fetchedRawBySlug = new Map<string, number>();
          for (const raw of fetchResult.successfulRaw.get(source) ?? []) {
            const slug = scopeSlugFor(source, raw.sourceId, slugs);
            if (slug !== null) fetchedRawBySlug.set(slug, (fetchedRawBySlug.get(slug) ?? 0) + 1);
          }
          const activeBySlug = new Map<string, number>();
          let unknownActive = 0;
          for (const r of rows) {
            const slug = scopeSlugFor(source, r.source_id, slugs);
            if (slug === null) unknownActive++;
            else activeBySlug.set(slug, (activeBySlug.get(slug) ?? 0) + 1);
          }
          const verdicts = classifyEmployerScopes({
            employers,
            fetchedRawBySlug,
            activeBySlug,
            fetchStartedAtMs: employerEvidence === 'bookkeeping' ? (fetchResult.fetchStartedAt ?? null) : null,
          });
          gate = buildScopeGate(source, slugs, verdicts);
          let observable = 0;
          let unobservable = 0;
          let unobservableRows = 0;
          for (const e of employers) {
            const v = verdicts.get(e.boardSlug)!;
            if (v.observable) {
              observable++;
              continue;
            }
            unobservable++;
            unobservableRows += activeBySlug.get(e.boardSlug) ?? 0;
            unobservableScopes.push({ source, boardSlug: e.boardSlug, reason: v.reason!, activeRows: activeBySlug.get(e.boardSlug) ?? 0 });
          }
          if (unknownActive > 0) {
            // active rows whose employer is no longer in the approved list: never absence-counted, retired at >N days unseen
            unobservableRows += unknownActive;
            unobservableScopes.push({ source, boardSlug: '(unknown)', reason: 'unknown-scope', activeRows: unknownActive });
          }
          employerScopes.set(source, { observable, unobservable, unobservableRows });
          stage = 'absence-scan';
        }

        absence.set(source, planAbsence(source, rows, presentBySource.get(source) ?? new Set(), coverage.get(source)!, policy, gate));
      } catch (err) {
        // Fail closed: skip THIS source's absence pass entirely and say so (an evidence-read failure lands here too).
        absenceScanErrors.set(source, (err as Error).message);
        ctx.recordError(`${stage}(${source})`, err as Error, 1, false);
      }
    }
  });

  // 4. Unknown backlog. A row left 'unknown' (verification errored, or the run
  // deadline cut verification short) is invisible and not absence-tracked. For
  // a windowed source the feed may never list it again, so "re-queue when seen
  // again" (upsert branch) is not enough on its own: re-verify every unknown
  // row of a successful source, listed by the feed or not.
  let unknownBacklogQueued = 0;
  await ctx.phase('unknownBacklog', async () => {
    const queued = new Set(upserts.verify.map((v) => v.id));
    const reactivated = new Set(upserts.curatedReactivateIds);
    for (const source of successfulSources) {
      try {
        const rows = await fetchAllRows<{ id: string; source_id: string; official_url: string }>(
          (afterId, size) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let q: any = admin
              .from('opportunities')
              .select('id, source_id, official_url')
              .eq('source', source)
              .eq('status', 'unknown')
              .order('id', { ascending: true })
              .limit(size);
            if (options?.absenceScanSourceIdPrefix) q = q.like('source_id', `${options.absenceScanSourceIdPrefix}%`);
            if (afterId) q = q.gt('id', afterId);
            return q;
          },
          { label: `unknown backlog (${source})` }
        );
        ctx.requests += Math.floor(rows.length / 1000) + 1;
        for (const r of rows) {
          if (queued.has(r.id) || reactivated.has(r.id)) continue;
          unknownBacklogQueued++;
          if (source === 'curated') upserts.curatedReactivateIds.push(r.id);
          else upserts.verify.push({ id: r.id, source, sourceId: r.source_id, officialUrl: r.official_url, reason: 'unknown' });
        }
      } catch (err) {
        ctx.recordError(`unknown-backlog(${source})`, err as Error, 1, false);
      }
    }
  });

  return {
    nowIso,
    upserts,
    absence,
    coverage,
    fetchedBySource: new Map(Array.from(oppsBySource, ([s, o]) => [s, o.length])),
    keysLookedUpBySource: new Map(Array.from(keysBySource, ([s, k]) => [s, k.length])),
    existingRowsResolved: existingRows.length,
    absenceScanErrors,
    unknownBacklogQueued,
    unregistered,
    lookupsSkippedByGate,
    employerEvidence,
    employerScopes,
    unobservableScopes,
  };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export interface InsertOutcome {
  inserted: { id: string; source: string; source_id: string }[];
  /** rows that already existed (unique (source, source_id) hit) — NOT inserts */
  conflicts: number;
  failed: { count: number; message: string; code?: string }[];
}

/**
 * Race-safe bulk insert. One upsert(ignoreDuplicates) per chunk: a row that
 * already exists is skipped (and counted as a conflict, never as an insert)
 * instead of failing the whole chunk. If a chunk fails outright (e.g. one row
 * violates a constraint), it is retried row by row so the bad row is isolated
 * and reported while the good ones still land.
 */
export async function insertRowsIgnoringDuplicates(
  admin: Admin,
  rows: readonly Record<string, unknown>[],
  ctx?: { requests: number }
): Promise<InsertOutcome> {
  const out: InsertOutcome = { inserted: [], conflicts: 0, failed: [] };
  const attempt = async (batch: readonly Record<string, unknown>[]) => {
    if (ctx) ctx.requests++;
    return admin
      .from('opportunities')
      .upsert(batch as Record<string, unknown>[], { onConflict: 'source,source_id', ignoreDuplicates: true })
      .select('id, source, source_id');
  };

  for (const batch of chunk(rows, INSERT_CHUNK)) {
    const res = await attempt(batch);
    if (!res.error) {
      const got = (res.data ?? []) as { id: string; source: string; source_id: string }[];
      out.inserted.push(...got);
      out.conflicts += batch.length - got.length;
      continue;
    }
    for (const row of batch) {
      const one = await attempt([row]);
      if (one.error) out.failed.push({ count: 1, message: one.error.message, code: one.error.code });
      else {
        const got = (one.data ?? []) as { id: string; source: string; source_id: string }[];
        out.inserted.push(...got);
        out.conflicts += 1 - got.length;
      }
    }
  }
  return out;
}

async function bulkUpdateByIds(
  admin: Admin,
  ctx: RunContext,
  op: string,
  ids: readonly string[],
  patch: Record<string, unknown>
): Promise<number> {
  let written = 0;
  await runPool(chunk(ids, ID_CHUNK), DB_CONCURRENCY, async (batch) => {
    ctx.requests++;
    const res = await admin.from('opportunities').update(patch).in('id', batch).select('id');
    if (res.error) {
      ctx.recordError(op, res.error, batch.length);
      return;
    }
    const n = (res.data ?? []).length;
    written += n;
    if (n !== batch.length) ctx.recordError(`${op}:rowcount`, `expected ${batch.length} rows, database changed ${n}`, batch.length - n);
  });
  return written;
}

function emitRollback(entry: RollbackEntry, options: SyncOptions | undefined): void {
  if (options?.rollbackSink) {
    void options.rollbackSink(entry);
    return;
  }
  for (const ids of chunk(entry.ids, 400)) {
    console.info('[catalog-sync:rollback]', JSON.stringify({ ...entry, ids }));
  }
}

// ---------------------------------------------------------------------------
// the corrected run
// ---------------------------------------------------------------------------

function emptySummary(fetchResult: ProviderFetchResult): SyncSummary {
  return {
    providerOutcomes: fetchResult.outcomes,
    newJobsVerifiedActive: 0,
    newJobsVerifiedExpired: 0,
    newJobsVerificationErrored: 0,
    reappearedVerifiedActive: 0,
    reappearedVerifiedExpired: 0,
    refreshedExistingActive: 0,
    absenceIncremented: 0,
    expiredByAbsence: 0,
    draftCount: 0,
    explicitlyExpiredCount: 0,
  };
}

function baseReport(mode: SyncMode, applied: boolean, ctx: RunContext, startedAt: number, deadlineMs: number, plan: CatalogPlan | null): LifecycleReport {
  const bySource: Record<string, SourceLifecycle> = {};
  if (plan) {
    for (const [source, cov] of Array.from(plan.coverage.entries())) {
      const abs = plan.absence.get(source);
      const wm = windowMetrics(cov, Date.parse(plan.nowIso));
      bySource[source] = {
        coverage: cov.coverage,
        floor: cov.coverage === 'windowed' && cov.floorMs !== null ? new Date(cov.floorMs).toISOString() : null,
        fetched: plan.fetchedBySource.get(source) ?? 0,
        keysLookedUp: plan.keysLookedUpBySource.get(source) ?? 0,
        activeScanned: abs ? abs.scanned : null,
        present: abs?.present ?? 0,
        unobservable: abs?.unobservable ?? 0,
        legacyCountersInflated: abs?.legacyCountersInflated ?? 0,
        windowHours: wm.windowHours,
        newestAgeHours: wm.newestAgeHours,
        gapMarginHours: wm.gapMarginHours,
        gapRisk: wm.gapRisk,
        employerScopes: plan.employerScopes.get(source) ?? null,
        incremented: 0,
        expired: 0,
        retired: 0,
        wouldExpire: abs?.wouldExpire ?? 0,
        wouldRetire: abs?.wouldRetire ?? 0,
        held: abs?.held ?? null,
        ...(plan.absenceScanErrors.has(source) ? { absenceScanError: plan.absenceScanErrors.get(source) } : {}),
      };
    }
  }
  return {
    mode,
    applied,
    durationMs: Date.now() - startedAt,
    phaseTimingsMs: ctx.phaseTimingsMs,
    deadlineMs,
    deadlineReached: false,
    requests: ctx.requests,
    bySource,
    unregisteredSources: plan?.unregistered ?? [],
    unobservableScopes: plan?.unobservableScopes ?? [],
    employerEvidence: plan?.employerEvidence ?? 'off',
    gapRiskSources: Object.entries(bySource).filter(([, b]) => b.gapRisk).map(([s]) => s),
    lookupsSkippedByGate: plan?.lookupsSkippedByGate ?? 0,
    existingRowsResolved: plan?.existingRowsResolved ?? 0,
    gateSkipped: plan?.upserts.gateSkipped ?? 0,
    inserts: { planned: plan?.upserts.inserts.length ?? 0, written: 0, conflicts: 0 },
    touched: 0,
    contentUpdated: 0,
    verification: { queued: 0, active: 0, expired: 0, errored: 0, deferred: 0, requeuedUnknown: 0, backlogQueued: plan?.unknownBacklogQueued ?? 0 },
    writeFailures: ctx.writeFailures,
    errors: ctx.errors,
  };
}

/** Shadow: plan only. Reads, no writes. Used both by the dispatcher (alongside
 *  the legacy path) and directly by shadow-run tooling. */
export async function planCatalogSyncReadOnly(fetchResult: ProviderFetchResult, options?: SyncOptions): Promise<LifecycleReport> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) throw new Error('Supabase admin client is not configured — cannot plan the catalog sync.');
  const startedAt = Date.now();
  const deadlineMs = resolveDeadlineMs(options);
  const ctx = new RunContext();
  const successful = fetchResult.outcomes.some((o) => o.success);
  if (!successful) return baseReport('shadow', false, ctx, startedAt, deadlineMs, null);
  const plan = await buildCatalogPlan(admin, fetchResult, options, 'shadow', ctx);
  return baseReport('shadow', false, ctx, startedAt, deadlineMs, plan);
}

export async function runCorrectedCatalogSync(
  fetchResult: ProviderFetchResult,
  options: SyncOptions | undefined,
  mode: 'observe' | 'full'
): Promise<SyncSummary> {
  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) throw new Error('Supabase admin client is not configured — cannot sync the catalog.');

  const startedAt = Date.now();
  const deadlineMs = resolveDeadlineMs(options);
  const deadlineAt = startedAt + deadlineMs;
  const ctx = new RunContext();
  const summary = emptySummary(fetchResult);

  if (!fetchResult.outcomes.some((o) => o.success)) {
    // Every provider failed: a complete no-op on the catalog, by design.
    summary.lifecycle = baseReport(mode, true, ctx, startedAt, deadlineMs, null);
    return summary;
  }

  const plan = await buildCatalogPlan(admin, fetchResult, options, mode, ctx);
  const report = baseReport(mode, true, ctx, startedAt, deadlineMs, plan);
  const up = plan.upserts;
  const now = plan.nowIso;

  // Durable recovery record for every status change this run will make (spec
  // §7). Expiries/retirements are bounded by the limiter, so logging ids is
  // cheap; absence-counter changes self-heal and are not recorded.
  for (const [source, abs] of Array.from(plan.absence.entries())) {
    if (abs.expireIds.length) emitRollback({ runAt: now, op: 'expire', source, ids: abs.expireIds }, options);
    if (abs.retireIds.length) emitRollback({ runAt: now, op: 'retire', source, ids: abs.retireIds }, options);
  }

  await ctx.phase('applyInserts', async () => {
    const byKind = new Map<InsertKind, PlannedInsert[]>();
    for (const ins of up.inserts) {
      const list = byKind.get(ins.kind);
      if (list) list.push(ins);
      else byKind.set(ins.kind, [ins]);
    }
    // A group has a uniform column set, so bulk insert never sends ragged rows.
    for (const [kind, group] of Array.from(byKind.entries())) {
      const res = await insertRowsIgnoringDuplicates(admin, group.map((g) => g.row), ctx);
      for (const f of res.failed) ctx.recordError(`insert(${kind})`, f, f.count);
      report.inserts.written += res.inserted.length;
      report.inserts.conflicts += res.conflicts;

      if (kind === 'draft') summary.draftCount += res.inserted.length;
      else if (kind === 'expired') summary.explicitlyExpiredCount += res.inserted.length;
      else if (kind === 'active') summary.newJobsVerifiedActive += res.inserted.length;
      else {
        const idByKey = new Map(res.inserted.map((r) => [`${r.source}:${r.source_id}`, r.id]));
        for (const g of group) {
          const id = idByKey.get(`${g.source}:${g.sourceId}`);
          if (id) up.verify.push({ id, source: g.source, sourceId: g.sourceId, officialUrl: g.officialUrl, reason: 'new' });
        }
      }
    }
  });

  await ctx.phase('applyRefresh', async () => {
    const touched = await bulkUpdateByIds(admin, ctx, 'touch', up.touchIds, { last_seen_in_feed_at: now, consecutive_absences: 0 });
    const draftTouched = await bulkUpdateByIds(admin, ctx, 'touch(draft)', up.draftTouchIds, { last_seen_in_feed_at: now });
    report.touched += touched + draftTouched;
    summary.refreshedExistingActive += touched;
    summary.draftCount += draftTouched;

    await runPool(up.contentUpdates, UPDATE_CONCURRENCY, async (u) => {
      ctx.requests++;
      const res = await admin.from('opportunities').update(u.patch).eq('id', u.id).select('id');
      if (res.error) {
        ctx.recordError(`update(${u.kind})`, res.error, 1);
        return;
      }
      report.contentUpdated++;
      if (u.kind === 'draft') summary.draftCount++;
      else if (u.kind === 'override') summary.explicitlyExpiredCount++;
      else if (u.kind === 'refresh') summary.refreshedExistingActive++;
    });

    const reactivated = await bulkUpdateByIds(admin, ctx, 'curated-reactivate', up.curatedReactivateIds, { status: 'active' });
    summary.reappearedVerifiedActive += reactivated;
  });

  await ctx.phase('applyAbsence', async () => {
    for (const [source, abs] of Array.from(plan.absence.entries())) {
      const rep = report.bySource[source];
      for (const [value, ids] of Array.from(abs.incrementByValue.entries())) {
        rep.incremented += await bulkUpdateByIds(admin, ctx, `absence++(${source})`, ids, { consecutive_absences: value });
      }
      if (abs.expireIds.length) {
        rep.expired = await bulkUpdateByIds(admin, ctx, `expire(${source})`, abs.expireIds, { status: 'expired', consecutive_absences: ABSENCE_EXPIRY_THRESHOLD });
      }
      if (abs.retireIds.length) {
        rep.retired = await bulkUpdateByIds(admin, ctx, `retire(${source})`, abs.retireIds, { status: 'expired' });
      }
      summary.absenceIncremented += rep.incremented + rep.expired;
      summary.expiredByAbsence += rep.expired;
    }
  });

  // Link verification — the ONLY deadline-bounded phase.
  await ctx.phase('verify', async () => {
    const queue = up.verify;
    report.verification.queued = queue.length;
    const results: { item: (typeof queue)[number]; reachable: boolean | null }[] = [];
    let started = 0;
    await runPool(
      queue,
      VERIFY_CONCURRENCY,
      async (item) => {
        started++;
        try {
          const check = await verifyLinkFreshness(item.officialUrl);
          results.push({ item, reachable: check.reachable });
        } catch {
          results.push({ item, reachable: null });
        }
      },
      () => Date.now() > deadlineAt
    );
    report.verification.deferred = queue.length - started;
    report.deadlineReached = report.verification.deferred > 0;

    const bucket = (reason: string, reachable: boolean | null) => results.filter((r) => r.item.reason === reason && r.reachable === reachable).map((r) => r.item.id);
    const nowVerified = new Date().toISOString();
    for (const reason of ['new', 'reappeared', 'unknown'] as const) {
      const active = bucket(reason, true);
      const expired = bucket(reason, false);
      const errored = bucket(reason, null).length;
      const okA = await bulkUpdateByIds(admin, ctx, `verify-active(${reason})`, active, { status: 'active', link_reachable: true, link_checked_at: nowVerified });
      const okE = await bulkUpdateByIds(admin, ctx, `verify-expired(${reason})`, expired, { status: 'expired', link_reachable: false, link_checked_at: nowVerified });
      report.verification.active += okA;
      report.verification.expired += okE;
      report.verification.errored += errored;
      if (reason === 'new') {
        summary.newJobsVerifiedActive += okA;
        summary.newJobsVerifiedExpired += okE;
        summary.newJobsVerificationErrored += errored;
      } else if (reason === 'reappeared') {
        summary.reappearedVerifiedActive += okA;
        summary.reappearedVerifiedExpired += okE;
      } else {
        report.verification.requeuedUnknown += okA + okE;
      }
    }
  });

  report.inserts.planned = plan.upserts.inserts.length;
  report.durationMs = Date.now() - startedAt;
  report.requests = ctx.requests;
  report.writeFailures = ctx.writeFailures;
  report.errors = ctx.errors;
  report.phaseTimingsMs = ctx.phaseTimingsMs;
  summary.lifecycle = report;
  return summary;
}
