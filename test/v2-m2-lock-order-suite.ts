/**
 * M2: lock order of the lifecycle writers.
 *
 * THIS IS A STATIC CHECK. It reads the SQL and applies lock-order rules. It cannot prove
 * that no deadlock happens; that needs two real connections holding locks in a forced
 * interleaving on a database. What this suite does give:
 *   - the rule checker is shown to FAIL on the definitions as they were before M2
 *     (so it can detect the bug), and to pass on the latest definitions;
 *   - the follow-up migration's function bodies are verified to be the previous latest
 *     definitions with only the intended lock changes (no silent drift);
 *   - error codes, grants and the in-migration self-check are checked.
 *
 * Rules (documented order: profile, then employer row, then candidate row):
 *   R1  a profile row is never locked FOR UPDATE in these writers (an employer decision
 *       inserts an event that references the profile, which needs FOR KEY SHARE);
 *   R2  lock statements appear in rank order profile < employer row < candidate row;
 *   R3  a function that writes an application event referencing the employer row locks
 *       the employer row before it locks the candidate row.
 *
 * Run: npx tsx test/v2-m2-lock-order-suite.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string): void {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}
const dir = join(__dirname, '..', 'supabase', 'migrations');
const FIX = readdirSync(dir).find((f) => f.includes('v2_p0_m2_lock_order_deadlock_fix'))!;
assert(!!FIX, 'the M2 follow-up migration exists');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const text = (f: string) => readFileSync(join(dir, f), 'utf8');

const WRITERS = [
  'apply_to_employer_job', 'transition_application_status', 'set_application_archived',
  'rewind_last_decision', 'transition_employer_application',
];

/** The latest definition of a function among the migrations that sort before `before`. */
function latest(name: string, before?: string): string {
  let found = '';
  for (const f of files) {
    if (before && f >= before) break;
    const s = text(f);
    let from = 0;
    for (;;) {
      const i = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, from);
      if (i < 0) break;
      const j = s.indexOf('\n$$;', i);
      found = s.slice(i, j + 4);
      from = j;
    }
  }
  return found;
}

type Lock = { table: 'profiles' | 'employer' | 'candidate'; mode: 'UPDATE' | 'NO KEY UPDATE' };
const RANK = { profiles: 0, employer: 1, candidate: 2 } as const;

function locksOf(body: string): Lock[] {
  const code = body.replace(/--[^\n]*/g, '');
  const out: Lock[] = [];
  for (const stmt of code.split(';')) {
    const m = /FOR\s+(NO KEY\s+)?UPDATE\b/.exec(stmt);
    if (!m) continue;
    const t = /FROM\s+public\.(\w+)/.exec(stmt);
    if (!t) continue;
    const table = t[1] === 'profiles' ? 'profiles' : t[1] === 'employer_job_applications' ? 'employer' : t[1] === 'applications' ? 'candidate' : null;
    if (table) out.push({ table, mode: m[1] ? 'NO KEY UPDATE' : 'UPDATE' });
  }
  return out;
}

function violations(name: string, body: string): string[] {
  const v: string[] = [];
  const locks = locksOf(body);
  if (locks.some((l) => l.table === 'profiles' && l.mode === 'UPDATE')) v.push('R1');
  for (let i = 1; i < locks.length; i++) {
    if (RANK[locks[i].table] < RANK[locks[i - 1].table]) { v.push('R2'); break; }
  }
  const code = body.replace(/--[^\n]*/g, '');
  const writesLinkedEvent = /INSERT INTO public\.application_events\s*\([^)]*employer_application_id/.test(code);
  if (writesLinkedEvent) {
    const firstEmployer = locks.findIndex((l) => l.table === 'employer');
    const firstCandidate = locks.findIndex((l) => l.table === 'candidate');
    if (firstEmployer < 0 || (firstCandidate >= 0 && firstEmployer > firstCandidate)) v.push('R3');
  }
  return v;
}

// --- red: the checker detects the defects in the definitions before M2 -----------------
const before = (n: string) => latest(n, FIX);
assert(WRITERS.every((n) => before(n).length > 0), 'every writer has a definition before M2');
assert(violations('set_application_archived', before('set_application_archived')).includes('R3'),
  'RED: before M2, set_application_archived locks the candidate row and writes a linked event with no employer lock (R3)');
for (const n of ['apply_to_employer_job', 'transition_application_status', 'rewind_last_decision']) {
  assert(violations(n, before(n)).includes('R1'), `RED: before M2, ${n} locks the profile FOR UPDATE (R1)`);
}
assert(violations('transition_employer_application', before('transition_employer_application')).length === 0,
  'the employer decision function is the reference order and already satisfies every rule');

// --- green: the latest definitions satisfy every rule ---------------------------------
for (const n of WRITERS) {
  const v = violations(n, latest(n));
  assert(v.length === 0, `GREEN: latest ${n} satisfies R1-R3${v.length ? ` (violates ${v.join(',')})` : ''}`);
}
assert(locksOf(latest('set_application_archived')).map((l) => l.table).join() === 'employer,candidate',
  'set_application_archived now locks employer then candidate, nothing else');
assert(locksOf(latest('transition_employer_application')).map((l) => l.table).join() === 'employer,candidate',
  'the employer decision function still locks employer then candidate');

// --- the checker itself: it does not pass everything ----------------------------------
assert(violations('x', 'SELECT 1 FROM public.profiles WHERE id=v_uid FOR UPDATE;').includes('R1'), 'checker: a profile FOR UPDATE is flagged');
assert(violations('x', 'SELECT 1 FROM public.profiles WHERE id=v_uid FOR NO KEY UPDATE;').length === 0, 'checker: a profile FOR NO KEY UPDATE is accepted');
assert(violations('x', 'SELECT 1 FROM public.applications WHERE id=a FOR UPDATE; SELECT 1 FROM public.employer_job_applications WHERE id=b FOR UPDATE;').includes('R2'), 'checker: candidate before employer is flagged');
assert(violations('x', 'SELECT 1 FROM public.applications WHERE id=a FOR UPDATE; INSERT INTO public.application_events(application_id,employer_application_id) VALUES(1,2);').includes('R3'), 'checker: a linked event without an employer lock is flagged');
assert(violations('x', '-- FOR UPDATE on profiles in a comment\nSELECT 1;').length === 0, 'checker: comments are ignored');

// --- the migration bodies are the previous definitions with only the intended change --
const fix = text(FIX);
const body = (name: string) => {
  const i = fix.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  return fix.slice(i, fix.indexOf('\n$$;', i) + 4);
};
const revertLock = (s: string) => s.replace(/profiles WHERE id=v_uid FOR NO KEY UPDATE;/g, 'profiles WHERE id=v_uid FOR UPDATE;');
for (const n of ['apply_to_employer_job']) {
  assert(revertLock(body(n)) === before(n), `${n}: identical to the previous definition except the profile lock mode`);
}

// rewind_last_decision additionally gained a PR #120 review-remediation fix: the unlinked
// (ELSE) branch now re-checks for a concurrently-created link under the applications lock
// before falling through to the DELETE, instead of relying only on v_app.status matching
// 'interested' as an implicit (and incomplete) proxy for "no link was created meanwhile".
const revertRewindLinkRecheck = (s: string) => s.replace(/\r\n/g, '\n').replace(
  `        IF FOUND AND v_app.status IS DISTINCT FROM 'interested' THEN
          RETURN jsonb_build_object('success',false,'error','application_state_conflict');
        END IF;
        -- Re-check for a link under the lock: the first lookup above (line ~395) was
        -- unlocked, so a concurrent apply_to_employer_job could have linked this exact
        -- application between that read and this lock being granted. Relying only on
        -- v_app.status matching 'interested' is not a sufficient guard: nothing proves a
        -- link cannot be created without changing that status. Re-check explicitly and
        -- take the same conflict path as the IF branch above, instead of falling through
        -- to the unconditional DELETE below (PR #120 review remediation).
        IF FOUND AND EXISTS (
          SELECT 1 FROM public.employer_job_applications WHERE candidate_application_id=v_app.id
        ) THEN
          RETURN jsonb_build_object('success',false,'error','application_submitted');
        END IF;`,
  `        IF FOUND AND v_app.status IS DISTINCT FROM 'interested' THEN
          RETURN jsonb_build_object('success',false,'error','application_state_conflict');
        END IF;`,
);
assert(revertLock(revertRewindLinkRecheck(body('rewind_last_decision'))) === before('rewind_last_decision').replace(/\r\n/g, '\n'),
  'rewind_last_decision: identical to the previous definition except the profile lock mode and the added concurrent-link recheck (PR #120 review remediation)');
assert(/EXISTS \(\s*SELECT 1 FROM public\.employer_job_applications WHERE candidate_application_id=v_app\.id\s*\)/.test(body('rewind_last_decision')),
  'rewind_last_decision: the unlinked branch re-checks for a link under the lock, not just the status side effect');

// transition_application_status additionally gained PR #120 review-remediation idempotent
// replay checks (both the linked and unlinked branches) on top of the lock-mode change, so
// it gets its own revert that strips both in addition to the lock-mode revert, keeping the
// same "no other silent drift" guarantee the loop above gives the other two writers.
const revertReplayChecks = (s: string) => s
  .replace(/\r\n/g, '\n')
  .replace(
    `    IF v_expected_candidate_status IS NULL OR v_app.status IS DISTINCT FROM v_expected_candidate_status THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;

    -- Idempotent replay: if the application is already in the requested target
    -- state AND the deterministic hiring_decision_events row for this exact
    -- transition already exists, this is a retry of an already-committed
    -- transition (e.g. a client retrying after a timeout), not a real conflict.
    -- Must be checked before the p_expected_status comparison below, because on
    -- a genuine replay v_app.status now equals p_new_status, not p_expected_status.
    v_employer_new_status:=CASE p_new_status
      WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined' ELSE NULL END;
    IF v_employer_new_status IS NOT NULL AND v_app.status=p_new_status AND v_eja.status=v_employer_new_status
       AND EXISTS (
         SELECT 1 FROM public.hiring_decision_events
         WHERE employer_application_id=v_eja.id
           AND idempotency_key='candidate-transition:'||v_eja.id::text||':'||v_employer_new_status
       ) THEN
      RETURN jsonb_build_object('success',true,'status',p_new_status,'replayed',true);
    END IF;

    IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
    IF NOT public.is_valid_linked_application_transition(v_app.status,p_new_status,'candidate') THEN
      RAISE EXCEPTION 'managed_by_employer_or_invalid_transition' USING ERRCODE='22023';
    END IF;
    IF v_employer_new_status IS NULL THEN RAISE EXCEPTION 'managed_by_employer' USING ERRCODE='22023'; END IF;`,
    `    IF v_expected_candidate_status IS NULL OR v_app.status IS DISTINCT FROM v_expected_candidate_status THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
    IF NOT public.is_valid_linked_application_transition(v_app.status,p_new_status,'candidate') THEN
      RAISE EXCEPTION 'managed_by_employer_or_invalid_transition' USING ERRCODE='22023';
    END IF;

    v_employer_new_status:=CASE p_new_status
      WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined' ELSE NULL END;
    IF v_employer_new_status IS NULL THEN RAISE EXCEPTION 'managed_by_employer' USING ERRCODE='22023'; END IF;`,
  )
  .replace(
    `  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;

  -- Idempotent replay: if the application is already in the requested target
  -- state AND the most recent recorded event for it is exactly this
  -- expected->new transition, this is a retry of an already-committed
  -- transition, not a real conflict. Matching only the LATEST event (not any
  -- historical one) avoids treating a legitimately repeated transition
  -- (e.g. interested -> applied -> withdrawn -> applied -> withdrawn again)
  -- as a stale replay of the earlier one.
  IF v_app.status=p_new_status AND EXISTS (
    SELECT 1 FROM (
      SELECT event_payload FROM public.application_events
      WHERE application_id=v_app.id AND event_type='status_changed'
      ORDER BY created_at DESC LIMIT 1
    ) last_event
    WHERE (last_event.event_payload->>'fromStatus')=p_expected_status
      AND (last_event.event_payload->>'toStatus')=p_new_status
  ) THEN
    RETURN jsonb_build_object('success',true,'status',p_new_status,'replayed',true);
  END IF;

  IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;`,
    `  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;`,
  );
assert(revertLock(revertReplayChecks(body('transition_application_status'))) === before('transition_application_status').replace(/\r\n/g, '\n'),
  'transition_application_status: identical to the previous definition except the profile lock mode and the two added idempotent-replay checks (PR #120 review remediation)');
assert(body('transition_application_status').includes("RETURN jsonb_build_object('success',true,'status',p_new_status,'replayed',true);"),
  'transition_application_status: both branches have a real replayed:true return path, not just a comment');
const raises = (s: string) => Array.from(new Set(Array.from(s.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)).map((m) => m[1]))).sort().join();
assert(raises(body('set_application_archived')) === raises(before('set_application_archived')), 'set_application_archived raises exactly the same error codes as before');
const errCode = (s: string, code: string) => new RegExp(`RAISE EXCEPTION '${code}' USING ERRCODE='([A-Z0-9]+)'`).exec(s)?.[1];
for (const code of ['unauthenticated', 'invalid_archive_request', 'application_not_found', 'not_direct_application', 'application_integrity_conflict']) {
  assert(errCode(body('set_application_archived'), code) === errCode(before('set_application_archived'), code), `set_application_archived: "${code}" keeps its SQLSTATE`);
}
assert(/SECURITY DEFINER/.test(body('set_application_archived')) && /SET search_path=public,pg_temp/.test(body('set_application_archived')), 'set_application_archived is still SECURITY DEFINER with a pinned search_path');
assert(/RETURN jsonb_build_object\('success',true,'changed',false,'archived',p_archived\)/.test(body('set_application_archived')) && /'changed',true/.test(body('set_application_archived')), 'set_application_archived keeps its return shape');
assert(/IF \(v_app\.archived_at IS NOT NULL\)=p_archived THEN/.test(body('set_application_archived')), 'archiving twice is still a no-op');

// --- grants, self-check, ordering -------------------------------------------------------
for (const sig of ['apply_to_employer_job(uuid,text)', 'transition_application_status(text,text,text,text)', 'set_application_archived(text,boolean)', 'rewind_last_decision()']) {
  assert(fix.includes(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC,anon;`) && fix.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`), `grants restated for ${sig}`);
}
assert(!/GRANT EXECUTE[^;]*TO (anon|PUBLIC)/i.test(fix), 'nothing is granted to anon or PUBLIC');
assert(/DO \$check\$/.test(fix) && fix.includes('m2 self-check'), 'the migration fails loudly if a definition did not take effect');
assert(FIX > '20261114200000' && files.filter((f) => f < FIX).every((f) => !f.includes('v2_p0_m3_legacy')), 'the M2 migration sorts after every PR #117 migration, including the payload-binding migration (20261114190000) and the M4 tripwire (20261114200000); a later follow-up may redefine these functions, and the GREEN checks above run on the latest definitions');
assert(files.filter((f) => f.slice(0, 14) === FIX.slice(0, 14)).length === 1, 'the migration version is unique');
const outsideBodies = fix.replace(/--[^\n]*/g, '').replace(/AS \$\$[\s\S]*?\n\$\$;/g, '').replace(/DO \$check\$[\s\S]*?\$check\$;/, '');
assert(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bINSERT\b|\bUPDATE\b|ALTER TABLE|CREATE TABLE|CREATE INDEX/i.test(outsideBodies), 'outside the function bodies the migration only redefines functions and restates grants: no table, index or data changes');

console.log(`\nV2 M2 lock order (static): ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
