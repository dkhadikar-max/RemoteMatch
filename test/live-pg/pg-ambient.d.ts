// Minimal ambient declaration for the `pg` driver, used ONLY so this prepared-but-not-run harness
// (resume-concurrency-live-suite.ts) typechecks without installing `pg`/`@types/pg` into this
// worktree's node_modules — an earlier attempt at that install destabilized this worktree's
// dependency tree (next/server types broke) and was reverted via `npm ci`. When the harness is
// actually run (see docs/resume-pr-b-live-concurrency-runbook.md), install the real `@types/pg`
// (`npm install --no-save pg @types/pg`) and this file can be deleted — the real types are
// preferred when present.
declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }
  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
  }
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
