/**
 * M3: legacy employer applications (no candidate link, no recorded submission).
 *
 * STATIC CHECK. It reads the SQL and the app source; it does not run the SQL. Behaviour on a
 * real database (a legacy row re-applying, a legacy rejection being reconsidered) has not
 * been exercised. What this gives:
 *   - RED/GREEN: the definitions before M3 do refuse these cases, the latest ones do not;
 *   - both functions use the SAME definition of "legacy", and a broken link is not "legacy";
 *   - the legacy replay writes nothing;
 *   - the copied bodies equal the previous definitions except the two intended blocks;
 *   - routes, button and the diagnostic file behave as described.
 *
 * Run: npx tsx test/v2-m3-legacy-suite.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string): void {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}
const root = join(__dirname, '..');
const dir = join(root, 'supabase', 'migrations');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const M3 = files.find((f) => f.includes('v2_p0_m3_legacy_employer_applications'))!;
const M2 = files.find((f) => f.includes('v2_p0_m2_lock_order_deadlock_fix'))!;
const text = (f: string) => readFileSync(join(dir, f), 'utf8');
assert(!!M3 && !!M2, 'the M2 and M3 follow-up migrations exist');
assert(M2 < M3 && files.indexOf(M3) > files.indexOf(M2), 'M3 sorts after M2 (stacked on it)');

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
const strip = (s: string) => s.replace(/--[^\n]*/g, '');
const norm = (s: string) => strip(s).replace(/\s+/g, ' ').trim();

// The two blocks M3 changes, as they were before M3.
const OLD_APPLY_BLOCK = `    IF v_eja.candidate_application_id IS NULL THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;`;
const OLD_EMPLOYER_BLOCK = "    IF v_corrects IS NULL THEN RAISE EXCEPTION 'rejection_event_missing' USING ERRCODE='P0001'; END IF;";
const applyBefore = latest('apply_to_employer_job', M3);
const applyNow = latest('apply_to_employer_job');
const employerBefore = latest('transition_employer_application', M3);
const employerNow = latest('transition_employer_application');

// --- RED: before M3 -----------------------------------------------------------------------
assert(applyBefore.includes(OLD_APPLY_BLOCK), 'RED: before M3, an unlinked row on re-apply goes straight to application_integrity_conflict');
assert(!applyBefore.includes("'legacy',true"), 'RED: before M3 there is no legacy replay');
assert(employerBefore.includes(OLD_EMPLOYER_BLOCK), 'RED: before M3, a missing rejection event always raises rejection_event_missing (no legacy exception)');

// --- GREEN: after M3 ----------------------------------------------------------------------
assert(!applyNow.includes(OLD_APPLY_BLOCK) && applyNow.includes("'legacy',true"), 'GREEN: re-applying to a legacy row now returns a replay marked legacy');
assert(!employerNow.includes(OLD_EMPLOYER_BLOCK), 'GREEN: the unconditional rejection_event_missing is gone');
assert(/IF v_corrects IS NULL AND NOT \(/.test(employerNow) && /RAISE EXCEPTION 'rejection_event_missing'/.test(employerNow), 'GREEN: rejection_event_missing is still raised outside the legacy case');

// the legacy replay must not write anything
const replayStart = applyNow.indexOf("IF v_eja.candidate_application_id IS NULL THEN");
const replayEnd = applyNow.indexOf("RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';", replayStart);
const replayBlock = strip(applyNow.slice(replayStart, replayEnd));
assert(replayStart > 0 && replayEnd > replayStart, 'the legacy replay block was found');
assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(replayBlock), 'the legacy replay writes nothing');
assert(/'replayed',true/.test(replayBlock) && /'candidateApplication',NULL/.test(replayBlock) && /'success',true/.test(replayBlock), 'the replay reports success, replayed=true and no candidate application');
assert(/'application',jsonb_build_object\('id',v_eja\.id,'status',v_eja\.status,'submitted_at',v_eja\.submitted_at\)/.test(replayBlock), 'the replay returns the real application id, status and submission time');

// one definition of "legacy" in both functions
const legacyClause = (s: string) => {
  const m = /NOT EXISTS \(\s*SELECT 1 FROM public\.hiring_decision_events\s*WHERE employer_application_id=v_eja\.id AND action='application_submitted'\s*\)/.exec(strip(s));
  return m ? norm(m[0]) : '';
};
assert(legacyClause(applyNow) !== '' && legacyClause(applyNow) === legacyClause(employerNow), 'apply and reconsider use the identical test for "legacy" (no recorded application_submitted event)');
assert(/v_eja\.candidate_application_id IS NULL AND NOT EXISTS/.test(norm(employerNow).replace(/\s+/g, ' ')) , 'reconsider also requires that the row has no link');
assert(/RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';\s*END IF;\s*SELECT \* INTO v_app FROM public\.applications/.test(applyNow), 'an unlinked row that DOES have its submission event still raises application_integrity_conflict');

// --- nothing else drifted -------------------------------------------------------------------
const body = (name: string) => {
  const s = text(M3);
  const i = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  return s.slice(i, s.indexOf('\n$$;', i) + 4);
};
const cutBlock = (s: string, from: string, to: string) => {
  const i = s.indexOf(from);
  return i < 0 ? s : s.slice(0, i) + '<<BLOCK>>' + s.slice(s.indexOf(to, i) + to.length);
};
assert(
  cutBlock(body('apply_to_employer_job'), "    IF v_eja.candidate_application_id IS NULL THEN\n      -- No link", "      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';\n    END IF;")
    === cutBlock(applyBefore, "    IF v_eja.candidate_application_id IS NULL THEN\n      RAISE", "    END IF;"),
  'apply_to_employer_job: identical to the previous (M2) definition outside the legacy block',
);
assert(
  cutBlock(body('transition_employer_application'), "    -- A rejection recorded before", "      RAISE EXCEPTION 'rejection_event_missing' USING ERRCODE='P0001';\n    END IF;")
    === cutBlock(employerBefore, "    IF v_corrects IS NULL THEN RAISE", "END IF;"),
  'transition_employer_application: identical to the previous definition outside the legacy block',
);
assert(/profiles WHERE id=v_uid FOR NO KEY UPDATE/.test(body('apply_to_employer_job')) && !/profiles WHERE id=v_uid FOR UPDATE/.test(body('apply_to_employer_job')), "M2's lock fix is kept in apply_to_employer_job");
assert(/auth\.role\(\) IS DISTINCT FROM 'service_role'/.test(body('transition_employer_application')), 'the employer function still refuses anything but the service role');
// the employer function must be built from the payload-binding definition, or this migration would silently revert it
const PAYLOAD = ['v_event.previous_state IS DISTINCT FROM p_expected_status', 'v_event.reason_code IS DISTINCT FROM p_reason_code'];
assert(M3 > '20261114200000', 'M3 sorts after the payload-binding migration (20261114190000) and the M4 tripwire (20261114200000)');
assert(PAYLOAD.every((p) => employerBefore.includes(p)), 'the definition M3 starts from already has the idempotency payload binding');
assert(PAYLOAD.every((p) => body('transition_employer_application').includes(p)), 'M3 KEEPS the idempotency payload binding (it would revert it if built from the older body)');
assert(PAYLOAD.every((p) => employerNow.includes(p)), 'the effective definition after M3 has the payload binding and the legacy reconsideration');
assert(text(M3).includes('lost the idempotency payload binding'), 'the migration self-check fails if the payload binding is ever lost');
assert(/SECURITY DEFINER/.test(body('apply_to_employer_job')) && /SECURITY INVOKER/.test(body('transition_employer_application')), 'security modes are unchanged (apply: definer, employer decision: invoker)');

// --- grants, self-check, scope ------------------------------------------------------------
const m3 = text(M3);
assert(m3.includes('REVOKE ALL ON FUNCTION public.apply_to_employer_job(uuid,text) FROM PUBLIC,anon;') && m3.includes('GRANT EXECUTE ON FUNCTION public.apply_to_employer_job(uuid,text) TO authenticated;'), 'apply: grants restated unchanged');
assert(/REVOKE ALL ON FUNCTION public\.transition_employer_application\(uuid,uuid,uuid,text,text,text,text\)\s*FROM PUBLIC,anon,authenticated;/.test(m3) && /GRANT EXECUTE ON FUNCTION public\.transition_employer_application\(uuid,uuid,uuid,text,text,text,text\) TO service_role;/.test(m3), 'employer decision: still service-role only');
assert(!/GRANT EXECUTE[^;]*TO (anon|PUBLIC)/i.test(m3), 'nothing is granted to anon or PUBLIC');
assert(/DO \$check\$/.test(m3) && m3.includes('m3 self-check'), 'the migration fails loudly if a definition did not take effect');
const outside = m3.replace(/--[^\n]*/g, '').replace(/AS \$\$[\s\S]*?\n\$\$;/g, '').replace(/DO \$check\$[\s\S]*?\$check\$;/, '');
assert(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bINSERT\b|\bUPDATE\b|ALTER TABLE|CREATE TABLE|CREATE INDEX/i.test(outside), 'outside the function bodies: functions and grants only, no table or data changes (no backfill)');
assert(files.filter((f) => f.slice(0, 14) === M3.slice(0, 14)).length === 1 && M3 > M2, 'the M3 version is unique and sorts after M2 (a later follow-up may exist; the checks above run on the latest definitions)');

// --- routes, button ------------------------------------------------------------------------
const patchRoute = read('src/app/api/employer/companies/[id]/applications/route.ts');
const mapAt = patchRoute.indexOf("message.includes('rejection_event_missing')");
const lastAt = patchRoute.indexOf("return NextResponse.json({ error: 'Could not update applicant status.' }, { status: 500 })");
assert(mapAt > 0 && mapAt < lastAt, 'the employer route maps rejection_event_missing before the generic 500');
assert(/error: 'rejection_event_missing'[^}]*\}, \{ status: 409 \}/.test(patchRoute), 'it answers 409 with a readable message, not 500');
const button = read('src/components/employer/direct-employer-apply-button.tsx');
assert(button.includes('data.replayed') && button.includes('You have already applied'), 'the apply button says "already applied" on a replay instead of "Application submitted"');
assert(button.includes('data.message || data.error'), 'the apply button shows the readable message, not the raw error code');
assert(button.includes("replayed ? 'Already applied' : 'Application submitted'"), 'the button label matches the replay state');
const applyRoute = read('src/app/api/employer-jobs/[opportunityId]/apply/route.ts');
assert(/return NextResponse\.json\(data, \{ status: result\.replayed \? 200 : 201 \}\)/.test(applyRoute), 'the apply route still returns 200 for a replay and passes the body through');

// --- diagnostics file ----------------------------------------------------------------------
const diag = read('docs/v2-m3-legacy-diagnostics.sql');
const diagCode = diag.replace(/--[^\n]*/g, '');
assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(diagCode), 'the diagnostic SQL is read-only');
assert((diagCode.match(/\bSELECT\b/gi) || []).length >= 5 && !/\b(email|resume_file_url|full_name|name)\b/i.test(diagCode.replace(/candidate_/g, '')), 'the diagnostic returns counts only (no names, emails or resume links)');
assert(diag.includes('NOT RUN') && diag.includes('own explicit approval'), 'the diagnostic states it has not been run and needs approval for production');

console.log(`\nV2 M3 legacy applications (static): ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
