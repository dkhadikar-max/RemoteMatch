/**
 * Bounded translation-pass regression suite.
 *
 * All database behavior is injected and in-memory. No credentials, .env files,
 * production project, or live Gemini calls are used.
 */
import { translatePendingOpportunities } from "../src/lib/translation/translate-pending";
import type { BatchJobInput, BatchTranslationOutput } from "../src/lib/translation/gemini-translator";

type FakeRow = {
  id: string;
  posted_at: string | null;
  status: string;
  title: string;
  description: string;
  content_hash: string;
  translation_status: string | null;
  translated_content_hash: string | null;
};

type QueryLog = {
  columns: string;
  limit: number | null;
  ids: string[] | null;
  gt: Array<[string, unknown]>;
  orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>;
};

function makeRow(id: string, postedAt: number, status: string | null = null, contentHash = "new", translatedHash: string | null = null): FakeRow {
  return {
    id,
    posted_at: postedAt < 0 ? null : new Date(postedAt).toISOString(),
    status: "active",
    title: "Original title " + id,
    description: "Dies ist die deutsche Beschreibung dieser Stelle und enthält genügend Text für die Validierung.",
    content_hash: contentHash,
    translation_status: status,
    translated_content_hash: translatedHash,
  };
}

function fakeAdmin(seed: FakeRow[]) {
  const rows = seed.map((row) => ({ ...row }));
  const logs: QueryLog[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  class Query {
    mode: "select" | "update" = "select";
    columns = "*";
    patch: Record<string, unknown> = {};
    filters: Array<(row: FakeRow) => boolean> = [];
    orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];
    max: number | null = null;
    ids: string[] | null = null;
    gtFilters: Array<[string, unknown]> = [];

    select(columns: string) { this.columns = columns; return this; }
    update(patch: Record<string, unknown>) { this.mode = "update"; this.patch = patch; return this; }
    eq(column: string, value: unknown) {
      this.filters.push((row) => (row as any)[column] === value);
      if (this.mode === "update") return Promise.resolve(this.execute());
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push((row) => value === null ? (row as any)[column] == null : (row as any)[column] === value);
      return this;
    }
    gte(column: string, value: string) {
      this.filters.push((row) => typeof (row as any)[column] === "string" && ((row as any)[column] as string) >= value);
      return this;
    }
    gt(column: string, value: unknown) {
      this.gtFilters.push([column, value]);
      this.filters.push((row) => String((row as any)[column]) > String(value));
      return this;
    }
    in(column: string, values: string[]) {
      this.ids = values.slice();
      const set = new Set(values);
      this.filters.push((row) => set.has(String((row as any)[column])));
      return this;
    }
    order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      this.orders.push({ column, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst === true });
      return this;
    }
    limit(value: number) { this.max = value; return this; }

    execute(): any {
      if (this.mode === "update") {
        const matches = rows.filter((row) => this.filters.every((filter) => filter(row)));
        for (const row of matches) {
          Object.assign(row, this.patch);
          updates.push({ id: row.id, patch: { ...this.patch } });
        }
        return { error: null };
      }

      logs.push({ columns: this.columns, limit: this.max, ids: this.ids, gt: this.gtFilters.slice(), orders: this.orders.slice() });
      let found = rows.filter((row) => this.filters.every((filter) => filter(row)));
      for (const order of this.orders.slice().reverse()) {
        found = found.slice().sort((a, b) => {
          const av = (a as any)[order.column] as string | null;
          const bv = (b as any)[order.column] as string | null;
          if (av == null || bv == null) {
            if (av == null && bv == null) return 0;
            return av == null ? (order.nullsFirst ? -1 : 1) : (order.nullsFirst ? 1 : -1);
          }
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return order.ascending ? cmp : -cmp;
        });
      }
      if (this.max !== null) found = found.slice(0, this.max);
      const cols = this.columns.split(",").map((s) => s.trim());
      const data = found.map((row) => {
        if (this.columns === "*") return { ...row };
        const out: Record<string, unknown> = {};
        for (const col of cols) out[col] = (row as any)[col];
        return out;
      });
      return { data, error: null };
    }

    then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }

  return {
    admin: { from: () => new Query() } as any,
    rows,
    logs,
    updates,
  };
}

const GOOD = (id: string): BatchTranslationOutput => ({
  id,
  detectedLanguage: "de",
  translatedTitle: "Translated title for " + id,
  translatedDescription: "This is the English translation of the job description, long enough to pass the length guard comfortably.",
});

const goodTranslator = async (jobs: BatchJobInput[]) => jobs.map((job) => GOOD(job.id));
let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail?: string) {
  if (ok) { console.log("PASS " + label); passed++; }
  else { console.error("FAIL " + label + (detail ? " — " + detail : "")); failed++; }
}
const now = Date.parse("2026-11-12T12:00:00.000Z");

async function main() {
  // 1. Pending rows have no 48-hour restriction.
  {
    const db = fakeAdmin([makeRow("old-pending", now - 30 * 86400_000)]);
    const seen: string[] = [];
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 1, clock: () => now, translate: async (jobs) => { seen.push(...jobs.map((j) => j.id)); return goodTranslator(jobs); } });
    check(seen[0] === "old-pending" && summary.translated === 1, "old pending row (30 days) is selected");
  }

  // 2. Pending candidates are newest-first, then id.
  {
    const db = fakeAdmin([
      makeRow("older", now - 1000),
      makeRow("newer-b", now),
      makeRow("newer-a", now),
    ]);
    let order: string[] = [];
    await translatePendingOpportunities({ admin: db.admin, maxRows: 3, clock: () => now, translate: async (jobs) => { order = jobs.map((j) => j.id); return goodTranslator(jobs); } });
    check(order.join(",") === "newer-a,newer-b,older", "pending selection orders posted_at DESC NULLS LAST, id");
  }

  // 3. Pending query is one bounded read with a single lookahead row.
  {
    const db = fakeAdmin([makeRow("a", now), makeRow("b", now - 1), makeRow("c", now - 2)]);
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 2, clock: () => now, translate: goodTranslator });
    const pending = db.logs.find((log) => log.columns.includes("posted_at") && !log.columns.includes("description"));
    const detail = db.logs.find((log) => log.columns.includes("description"));
    check(pending?.limit === 3 && detail?.ids?.length === 2 && summary.examined === 2, "pending read uses budget+1 and details exclude lookahead");
  }

  // 4. Lookahead is excluded from examined and notAttempted.
  {
    const db = fakeAdmin([makeRow("a", now), makeRow("b", now - 1), makeRow("c", now - 2)]);
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 2, clock: () => now, translate: goodTranslator });
    check(summary.examined === 2 && summary.notAttempted === 0 && summary.stoppedReason === "row_budget", "lookahead detects row_budget but is not counted");
  }

  // 5. A 300-row attempted budget does not count the 700-row backlog as notAttempted.
  {
    const seed = Array.from({ length: 1000 }, (_, i) => makeRow("p-" + String(i).padStart(4, "0"), now - i));
    const db = fakeAdmin(seed);
    let calls = 0;
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 300, clock: () => now, translate: async (jobs) => { calls++; return goodTranslator(jobs); } });
    const untouched = db.rows.filter((row) => row.translation_status == null).length;
    check(calls === 30 && summary.examined === 300 && summary.notAttempted === 0 && summary.stoppedReason === "row_budget" && untouched === 700, "300 attempted rows cap at 30 Gemini calls; 700 backlog rows remain untouched and uncounted");
  }

  // 6. Stale retranslation excludes rows older than 48 hours.
  {
    const db = fakeAdmin([makeRow("stale-too-old", now - 49 * 3600_000, "ok", "new", "old")]);
    let calls = 0;
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 5, clock: () => now, translate: async (jobs) => { calls++; return goodTranslator(jobs); } });
    check(calls === 0 && summary.examined === 0, "stale retranslation excludes rows older than 48 hours");
  }

  // 7. Stale rows inside 48 hours are retranslated only when hashes differ.
  {
    const db = fakeAdmin([
      makeRow("stale-changed", now - 3600_000, "ok", "new-hash", "old-hash"),
      makeRow("stale-same", now - 3600_000, "ok", "same", "same"),
    ]);
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 5, clock: () => now, translate: goodTranslator });
    check(summary.examined === 1 && summary.retranslated === 1 && db.rows.find((row) => row.id === "stale-same")?.translation_status === "ok", "stale retranslation requires a changed content hash");
  }

  // 8. Stale candidates use id-keyset pagination, not offset paging.
  {
    const seed = Array.from({ length: 1001 }, (_, i) => makeRow("stale-" + String(i + 1).padStart(4, "0"), now - 3600_000, "ok", "same", "same"));
    seed[1000].content_hash = "changed";
    seed[1000].translated_content_hash = "old";
    const db = fakeAdmin(seed);
    let seen: string[] = [];
    await translatePendingOpportunities({ admin: db.admin, maxRows: 1, clock: () => now, translate: async (jobs) => { seen = jobs.map((job) => job.id); return goodTranslator(jobs); } });
    check(db.logs.some((log) => log.gt.some(([column, value]) => column === "id" && value === "stale-1000")) && seen[0] === "stale-1001", "stale scan advances by id keyset across page boundaries");
  }

  // 9. Stale scan may examine more than 300 rows, but details stay within budget.
  {
    const seed = Array.from({ length: 450 }, (_, i) => makeRow("stale-" + String(i + 1).padStart(4, "0"), now - 3600_000, "ok", "new-" + i, "old-" + i));
    const db = fakeAdmin(seed);
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 300, clock: () => now, translate: goodTranslator });
    const detail = db.logs.find((log) => log.columns.includes("description"));
    check(summary.examined === 300 && summary.stoppedReason === "row_budget" && detail?.ids?.length === 300, "stale scan examines 450 lightweight candidates but fetches descriptions only for 300");
  }

  // 10. A time budget stops new batches but lets the in-flight batch finish.
  {
    const db = fakeAdmin(Array.from({ length: 30 }, (_, i) => makeRow("time-" + i, now - i)));
    let clockNow = now;
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 30, maxMs: 100, clock: () => clockNow,
      translate: async (jobs) => { calls++; clockNow += 101; return goodTranslator(jobs); },
    });
    check(calls === 1 && summary.translated === 10 && summary.notAttempted === 20 && summary.stoppedReason === "time_budget", "deadline blocks the next batch while the in-flight batch completes");
  }

  // 11. notAttempted counts identified unsent candidates, never unscanned backlog.
  {
    const db = fakeAdmin(Array.from({ length: 1000 }, (_, i) => makeRow("clock-" + i, now - i)));
    let clockNow = now;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 10, maxMs: 10, clock: () => clockNow,
      translate: async (jobs) => { clockNow += 11; return goodTranslator(jobs); },
    });
    check(summary.examined === 10 && summary.notAttempted === 0 && summary.stoppedReason === "time_budget", "backlog beyond lookahead is excluded from notAttempted even when deadline expires");
  }

  // 12. Gemini request timeout is 20s by default and is not retried.
  {
    const db = fakeAdmin(Array.from({ length: 10 }, (_, i) => makeRow("timeout-" + i, now - i)));
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 10, clock: () => now, requestTimeoutMs: 5,
      translate: async () => { calls++; return new Promise<BatchTranslationOutput[]>(() => {}); },
    });
    check(calls === 1 && summary.deferred === 10 && db.rows.every((row) => row.translation_status == null), "request timeout is not retried and leaves the batch pending");
  }

  // 13. A 5xx receives exactly one retry; a successful retry resets failures.
  {
    const db = fakeAdmin(Array.from({ length: 10 }, (_, i) => makeRow("retry-" + i, now - i)));
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 10, clock: () => now, retryDelayMs: 0,
      translate: async (jobs) => { calls++; if (calls === 1) throw Object.assign(new Error("HTTP 503 overloaded"), { status: 503 }); return goodTranslator(jobs); },
    });
    check(calls === 2 && summary.translated === 10 && summary.deferred === 0, "HTTP 5xx retries once and successful retry is a batch success");
  }

  // 14. Two consecutive failed 5xx batches open provider_failures.
  {
    const db = fakeAdmin(Array.from({ length: 30 }, (_, i) => makeRow("fail-" + i, now - i)));
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 30, clock: () => now, retryDelayMs: 0,
      translate: async () => { calls++; throw Object.assign(new Error("HTTP 503 overloaded"), { status: 503 }); },
    });
    check(calls === 4 && summary.deferred === 20 && summary.notAttempted === 10 && summary.stoppedReason === "provider_failures" && summary.errors === 0, "two consecutive failed batches stop before batch three and preserve pending rows");
  }

  // 15. A 429 opens provider_limit immediately without retry.
  {
    const db = fakeAdmin(Array.from({ length: 20 }, (_, i) => makeRow("quota-" + i, now - i)));
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 20, clock: () => now, retryDelayMs: 0,
      translate: async () => { calls++; throw Object.assign(new Error("429 quota exceeded"), { status: 429 }); },
    });
    check(calls === 1 && summary.deferred === 10 && summary.notAttempted === 10 && summary.stoppedReason === "provider_limit" && summary.errors === 0, "429 stops immediately, is not retried, and leaves current/remaining rows pending");
  }

  // 16. A successful batch resets the consecutive-failure counter.
  {
    const db = fakeAdmin(Array.from({ length: 40 }, (_, i) => makeRow("reset-" + i, now - i)));
    let calls = 0;
    const summary = await translatePendingOpportunities({
      admin: db.admin, maxRows: 40, clock: () => now, retryDelayMs: 0,
      translate: async (jobs) => {
        calls++;
        if (calls === 1 || calls === 2 || calls === 4 || calls === 5 || calls === 6 || calls === 7) {
          throw Object.assign(new Error("HTTP 503 overloaded"), { status: 503 });
        }
        return goodTranslator(jobs);
      },
    });
    check(calls === 7 && summary.translated === 10 && summary.deferred === 30 && summary.stoppedReason === "provider_failures", "success resets failure streak; only two later consecutive failed batches open the breaker");
  }

  // 17. Existing summary fields retain their meaning, including retranslated and deferred.
  {
    const db = fakeAdmin([
      makeRow("retranslated", now, "ok", "new", "old"),
      makeRow("pending", now - 1),
    ]);
    const summary = await translatePendingOpportunities({ admin: db.admin, maxRows: 2, clock: () => now, translate: goodTranslator });
    check(summary.examined === 2 && summary.translated === 2 && summary.retranslated === 1 && summary.errors === 0 && summary.deferred === 0 && summary.provider === "gemini", "legacy summary counters remain intact alongside new accounting fields");
  }

  // 18. Stop-reason precedence: provider_limit/provider_failures override time and row budgets.
  {
    const quotaDb = fakeAdmin(Array.from({ length: 30 }, (_, i) => makeRow("precedence-q-" + i, now - i)));
    let quotaClock = now;
    const quota = await translatePendingOpportunities({
      admin: quotaDb.admin, maxRows: 20, maxMs: 10, clock: () => quotaClock,
      translate: async () => { quotaClock += 11; throw new Error("429 quota exceeded"); },
    });
    const failDb = fakeAdmin(Array.from({ length: 30 }, (_, i) => makeRow("precedence-f-" + i, now - i)));
    let failClock = now;
    let calls = 0;
    const failures = await translatePendingOpportunities({
      admin: failDb.admin, maxRows: 20, maxMs: 3, clock: () => failClock, retryDelayMs: 0,
      translate: async () => { calls++; failClock += 1; throw Object.assign(new Error("HTTP 503"), { status: 503 }); },
    });
    check(quota.stoppedReason === "provider_limit" && failures.stoppedReason === "provider_failures", "provider stop reasons outrank elapsed time and row-budget lookahead");
  }

  console.log("\n" + passed + " passed, " + failed + " failed.");
  if (failed > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
