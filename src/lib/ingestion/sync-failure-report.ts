/**
 * Catalog-sync failure reporting.
 *
 * Why this exists: a scheduled run of POST /api/opportunities/sync returned
 * HTTP 500 and nothing recorded WHY — the route's catch returned the message
 * but never logged it, and the cron's `curl -f` throws the response body away.
 * So a failing cron left no diagnosable trace. This module turns a caught
 * exception into (a) one searchable log line and (b) a JSON error body, both
 * tagged with a short run id and the stage that failed.
 *
 * Hard rules:
 *  - NEVER leak a secret. Everything that reaches a log or a response goes
 *    through redactSecrets(): the VALUES of sensitive env vars, bearer
 *    tokens, authorization/secret/key/password/token fields, JWTs and known
 *    API-key shapes.
 *  - NEVER throw. This runs inside a catch block; failing to describe an
 *    error must not hide the error. Odd inputs (null, circular objects,
 *    symbols) degrade to a safe string.
 *  - Behaviour-neutral: it only describes an error. It does not decide
 *    status codes, retries or what the sync does.
 */

const REDACTED = '[REDACTED]';
const MAX_MESSAGE_CHARS = 600;
const MAX_STACK_LINES = 6;
const MAX_STACK_LINE_CHARS = 200;
/** Env values shorter than this are not treated as secrets (so "true", "1", "shadow" are never redacted). */
const MIN_SECRET_ENV_VALUE_LENGTH = 8;

/** Env var NAMES whose values must never appear in a log or response. */
const SENSITIVE_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|SERVICE_ROLE|PRIVATE|CREDENTIAL|_KEY$|^KEY$)/i;

export function newSyncRunId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  let out = text;

  // 1. The exact values of sensitive env vars (longest first so a value that
  //    contains another is replaced whole).
  const values = Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_ENV_VALUE_LENGTH)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join(REDACTED);

  // 2. Credential-shaped substrings, wherever they appear.
  out = out
    // user:password@ in a URL
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`)
    // Authorization-style fields: `Authorization: Bearer abc`, `api_key=abc`, `"token":"abc"`, ...
    .replace(
      /\b(authorization|x-internal-secret|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|secret|password|passwd|token)\b(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',;&]+/gi,
      `$1$2${REDACTED}`
    )
    // bare bearer tokens
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    // JWTs
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    // OpenAI-style, Google-style and Supabase-style key shapes
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/g, REDACTED);

  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/** Best-effort string for any thrown value; never throws. */
function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    try { return Object.prototype.toString.call(value); } catch { return 'unprintable value'; }
  }
}

export interface SyncFailureReport {
  runId: string;
  /** Which step of the route was running: request | revalidate | catalog_sync | translation | reconciliation | finish */
  stage: string;
  name: string;
  /** Redacted and truncated. */
  message: string;
  /** Postgres/PostgREST error code, when the thrown value carries one. */
  code?: string;
  /** Redacted `cause` message, when present. */
  cause?: string;
  /** First few stack frames, redacted. */
  stack?: string;
}

export interface SyncFailure {
  report: SyncFailureReport;
  /** One line, safe to console.error; searchable by `[sync <runId>]`. */
  logLine: string;
  /** The JSON error body (HTTP status stays whatever the route already returns). */
  body: { success: false; error: string; runId: string; stage: string };
}

export function describeSyncFailure(err: unknown, runId: string, stage: string): SyncFailure {
  let report: SyncFailureReport;
  try {
    const e = (err && typeof err === 'object' ? err : null) as
      | { name?: unknown; message?: unknown; code?: unknown; stack?: unknown; cause?: unknown }
      | null;
    const rawMessage = e && typeof e.message === 'string' ? e.message : safeString(err);
    report = {
      runId,
      stage,
      name: e && typeof e.name === 'string' && e.name ? e.name : typeof err === 'string' ? 'ThrownString' : 'UnknownError',
      message: clip(redactSecrets(rawMessage), MAX_MESSAGE_CHARS) || 'Unknown error',
    };
    if (e && (typeof e.code === 'string' || typeof e.code === 'number')) report.code = String(e.code);
    if (e && e.cause !== undefined && e.cause !== null) {
      const c = e.cause as { message?: unknown };
      report.cause = clip(redactSecrets(typeof c.message === 'string' ? c.message : safeString(e.cause)), MAX_MESSAGE_CHARS);
    }
    if (e && typeof e.stack === 'string') {
      report.stack = e.stack
        .split('\n')
        .slice(1, 1 + MAX_STACK_LINES)
        .map((l) => clip(redactSecrets(l.trim()), MAX_STACK_LINE_CHARS))
        .join(' | ');
    }
  } catch {
    report = { runId, stage, name: 'UnknownError', message: 'Unknown error (could not be described safely)' };
  }
  return {
    report,
    logLine: `[sync ${runId}] FAILED ${safeString(report)}`,
    body: { success: false, error: report.message, runId, stage },
  };
}
