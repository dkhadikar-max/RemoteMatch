/**
 * RemoteMatch — catalog-sync run log (observability only)
 * ==============================================================================
 * POST /api/opportunities/sync returns its summary (including the Item 1b `lifecycle` report) in the HTTP response, but the
 * cron's request is cut by Railway's edge at ~5 minutes while the translation pass that follows the sync runs for ~14, so the
 * response — and the shadow report in it — never reaches the cron log. This module turns the summary into a few short, structured
 * log lines that the ROUTE prints as soon as the sync returns (before translation), so they land in the app service's own logs.
 *
 * It reads a finished summary and prints. It decides nothing, writes nothing to the database, and cannot fail a sync: the
 * formatter never throws (any problem becomes one `log_format_error` line) and `logCatalogSyncResult` swallows sink errors.
 *
 * Output: lines of `[catalog-sync] <kind> <compact JSON>`, kinds: summary | lifecycle | source | shadow_plan_error | log_format_error.
 * Every line is bounded (see MAX_LINE_CHARS), built from an explicit allow-list of numeric/boolean/enum fields; free text (error
 * samples) is truncated and scrubbed of token-like strings. No payload bodies, no environment values.
 */

export const LOG_PREFIX = '[catalog-sync]';
/** Railway truncates very long log lines (believed ~5,000 chars); stay well under it. */
export const MAX_LINE_CHARS = 3000;
export const MAX_TEXT_CHARS = 300;
const MAX_ERRORS = 8;
const MAX_LIST = 20;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const word = (v: unknown, max = 60): string | null => (typeof v === 'string' ? scrub(v).slice(0, max) : null);

/** Remove token-like strings from free text before it is logged. */
export function scrub(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]')
    .replace(/\b(?:sk|pk|rk|whsec|sb)_[A-Za-z0-9_-]{8,}/gi, '[redacted-key]')
    .replace(/:\/\/[^/\s:@]+:[^@\s]+@/g, '://[redacted]@')
    .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/\b(api[_-]?key|secret|token|password|authorization)\b\s*[:=]?\s*(?!\[redacted\])\S+/gi, '$1=[redacted]');
}

export function text(v: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof v !== 'string') return null;
  const s = scrub(v).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Render one log line; if it is too long, shed the named bulky lists one at a time, then fall back to a stub. Exported for tests. */
export function line(kind: string, body: Json, droppable: string[] = []): string {
  const render = (b: Json): string => {
    try { return `${LOG_PREFIX} ${kind} ${JSON.stringify(b)}`; } catch { return `${LOG_PREFIX} ${kind} ${JSON.stringify({ unserializable: true })}`; }
  };
  let out = render(body);
  // Too long: shed the bulkiest optional lists one at a time (replacing each with its length) before giving up on the line.
  const slim: Json = { ...body };
  for (const key of droppable) {
    if (out.length <= MAX_LINE_CHARS) break;
    const v = slim[key];
    slim[key] = Array.isArray(v) ? { dropped: true, count: v.length } : { dropped: true };
    out = render(slim);
  }
  if (out.length > MAX_LINE_CHARS) out = `${LOG_PREFIX} ${kind} ${JSON.stringify({ truncated: true, originalChars: out.length })}`;
  return out;
}

function summaryLine(r: Json): string {
  const outcomes = Array.isArray(r.providerOutcomes) ? r.providerOutcomes.filter(isObj).slice(0, MAX_LIST) : [];
  return line('summary', {
    providers: outcomes.map((o) => ({ source: word(o.sourceKey), ok: bool(o.success), jobs: num(o.jobCount), ...(typeof o.error === 'string' ? { error: text(o.error) } : {}) })),
    newJobsVerifiedActive: num(r.newJobsVerifiedActive),
    newJobsVerifiedExpired: num(r.newJobsVerifiedExpired),
    newJobsVerificationErrored: num(r.newJobsVerificationErrored),
    reappearedVerifiedActive: num(r.reappearedVerifiedActive),
    reappearedVerifiedExpired: num(r.reappearedVerifiedExpired),
    refreshedExistingActive: num(r.refreshedExistingActive),
    absenceIncremented: num(r.absenceIncremented),
    expiredByAbsence: num(r.expiredByAbsence),
    draftCount: num(r.draftCount),
    explicitlyExpiredCount: num(r.explicitlyExpiredCount),
    hasLifecycle: isObj(r.lifecycle),
  }, ['providers']);
}

function lifecycleLines(l: Json): string[] {
  const out: string[] = [];
  const inserts = isObj(l.inserts) ? l.inserts : {};
  const ver = isObj(l.verification) ? l.verification : {};
  const unreg = Array.isArray(l.unregisteredSources) ? l.unregisteredSources.filter(isObj).slice(0, MAX_LIST) : [];
  const unobs = Array.isArray(l.unobservableScopes) ? l.unobservableScopes.filter(isObj).slice(0, MAX_LIST) : [];
  const errs = Array.isArray(l.errors) ? l.errors.filter(isObj) : [];
  out.push(line('lifecycle', {
    mode: word(l.mode), applied: bool(l.applied), durationMs: num(l.durationMs), deadlineMs: num(l.deadlineMs), deadlineReached: bool(l.deadlineReached),
    requests: num(l.requests),
    phaseTimingsMs: isObj(l.phaseTimingsMs) ? Object.fromEntries(Object.entries(l.phaseTimingsMs).slice(0, MAX_LIST).map(([k, v]) => [word(k, 40), num(v)])) : null,
    employerEvidence: word(l.employerEvidence),
    gapRiskSources: Array.isArray(l.gapRiskSources) ? l.gapRiskSources.slice(0, MAX_LIST).map((s) => word(s)) : null,
    unregisteredSources: unreg.map((u) => ({ source: word(u.source), fetched: num(u.fetched), skippedInserts: num(u.skippedInserts) })),
    unobservableScopes: unobs.map((u) => ({ source: word(u.source), board: word(u.boardSlug), reason: word(u.reason), activeRows: num(u.activeRows) })),
    lookupsSkippedByGate: num(l.lookupsSkippedByGate), existingRowsResolved: num(l.existingRowsResolved), gateSkipped: num(l.gateSkipped),
    inserts: { planned: num(inserts.planned), written: num(inserts.written), conflicts: num(inserts.conflicts) },
    touched: num(l.touched), contentUpdated: num(l.contentUpdated), writeFailures: num(l.writeFailures),
    verification: { queued: num(ver.queued), active: num(ver.active), expired: num(ver.expired), errored: num(ver.errored), deferred: num(ver.deferred), requeuedUnknown: num(ver.requeuedUnknown), backlogQueued: num(ver.backlogQueued) },
    errorCount: errs.length,
    errors: errs.slice(0, MAX_ERRORS).map((e) => ({ op: word(e.op, 80), count: num(e.count), code: word(e.code, 20), sample: text(e.sample, 200) })),
  }, ['errors', 'unobservableScopes', 'unregisteredSources', 'phaseTimingsMs', 'gapRiskSources']));
  const by = isObj(l.bySource) ? l.bySource : {};
  for (const [source, v] of Object.entries(by).slice(0, MAX_LIST)) {
    if (!isObj(v)) continue;
    const es = isObj(v.employerScopes) ? v.employerScopes : null;
    const held = isObj(v.held) ? v.held : null;
    out.push(line('source', {
      source: word(source), coverage: word(v.coverage), floor: word(v.floor, 40),
      fetched: num(v.fetched), keysLookedUp: num(v.keysLookedUp), activeScanned: num(v.activeScanned), present: num(v.present),
      unobservable: num(v.unobservable), legacyCountersInflated: num(v.legacyCountersInflated),
      windowHours: num(v.windowHours), newestAgeHours: num(v.newestAgeHours), gapMarginHours: num(v.gapMarginHours), gapRisk: bool(v.gapRisk),
      employerScopes: es ? { observable: num(es.observable), unobservable: num(es.unobservable), unobservableRows: num(es.unobservableRows) } : null,
      incremented: num(v.incremented), expired: num(v.expired), retired: num(v.retired), wouldExpire: num(v.wouldExpire), wouldRetire: num(v.wouldRetire),
      held: held ? { planned: num(held.planned), limit: num(held.limit), reason: word(held.reason, 20) } : null,
      ...(typeof v.absenceScanError === 'string' ? { absenceScanError: text(v.absenceScanError, 200) } : {}),
    }));
  }
  return out;
}

/** Build the log lines for a finished sync result. Never throws. */
export function formatCatalogSyncLog(result: unknown): string[] {
  try {
    if (!isObj(result)) return [line('log_format_error', { reason: 'result is not an object' })];
    const lines = [summaryLine(result)];
    if (isObj(result.lifecycle)) lines.push(...lifecycleLines(result.lifecycle));
    if (typeof result.shadowPlanError === 'string') lines.push(line('shadow_plan_error', { error: text(result.shadowPlanError) }));
    return lines;
  } catch (err) {
    try { return [line('log_format_error', { reason: text(String((err as Error)?.message ?? err), 200) })]; } catch { return []; }
  }
}

/** Print the lines; a sink that throws must never affect the sync. Returns the number of lines printed. */
export function logCatalogSyncResult(result: unknown, sink: (message: string) => void = (m) => console.log(m)): number {
  let printed = 0;
  try {
    for (const l of formatCatalogSyncLog(result)) { try { sink(l); printed++; } catch { /* a log sink must never fail a sync */ } }
  } catch { /* ditto */ }
  return printed;
}
