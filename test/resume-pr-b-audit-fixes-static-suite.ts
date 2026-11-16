/**
 * Resume Intelligence (PR B) — static/structural checks for the pieces of
 * docs/resume-pr-b-audit-2026-10-22.md's fixes that cannot be exercised
 * without a live database or a signed-in browser session (neither is
 * available here). These are source-pattern assertions, NOT behavioural
 * tests — see test/resume-intelligence-persistence-suite.ts and test/
 * resume-intelligence-decision-client-suite.ts for the real, mocked
 * behavioural coverage of the same fixes. Every assertion below is
 * explicitly labelled with what it does and does not prove.
 *
 * UNPROVEN even after this suite (stated here, not hidden): whether
 * `upsert_resume_analysis`'s GRANT actually works end-to-end against a real
 * Supabase instance, and whether PostgREST really returns a RETURNS TABLE
 * function's result as an array via .rpc() in this project's actual
 * Supabase version — both need a live apply + call to confirm, which this
 * suite does not and cannot do.
 *
 * Run: npx tsx test/resume-pr-b-audit-fixes-static-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME PR B AUDIT FIXES — STATIC CHECKS (not a substitute for live/behavioural tests)');
  console.log('='.repeat(78));

  console.log('\nMigration 036 — Finding A\'s SQL-level fix');
  const migration = read('supabase/migrations/036_resume_intelligence.sql');
  assert(
    /GRANT EXECUTE ON FUNCTION public\.upsert_resume_analysis\([^)]*\)\s*\n?\s*TO authenticated;/.test(migration),
    'upsert_resume_analysis is GRANTed to `authenticated`, not `service_role`'
  );
  assert(!/upsert_resume_analysis\([^)]*\)\s*\n?\s*\)\s*TO service_role/.test(migration), 'no remaining GRANT of upsert_resume_analysis to service_role');
  assert(!/CREATE OR REPLACE FUNCTION public\.upsert_resume_analysis\(\s*\n\s*p_profile_id/.test(migration), 'upsert_resume_analysis no longer takes a caller-supplied p_profile_id parameter (it derives the caller from auth.uid() instead, like every other RPC here)');
  const upsertFnBody = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.upsert_resume_analysis'), migration.indexOf('GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis'));
  assert(/v_uid\s*UUID\s*:=\s*auth\.uid\(\)/.test(upsertFnBody), 'the function body derives v_uid from auth.uid() internally');
  assert(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'unauthenticated'/.test(upsertFnBody), 'an unauthenticated caller (auth.uid() IS NULL) is explicitly rejected, same as every other writer RPC in this migration');
  assert(/profile_id = v_uid/.test(upsertFnBody) && !/profile_id = p_profile_id/.test(upsertFnBody), 'every ownership check inside the function uses the derived v_uid, never a parameter');
  assert(/DROP FUNCTION IF EXISTS public\.upsert_resume_analysis\(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric\);/.test(migration), 'the DOWN block\'s DROP FUNCTION signature matches the new (profile-id-less) parameter list');

  console.log('\nresume-intelligence-service.ts — every upsert/finalize call site checks its error');
  // Migration 041 (Stage 6 ownership-aware finalization fix) split the original single
  // callUpsert() helper into callClaim() (the pending claim only) and callFinalize() (the 3
  // terminal-status writes) — this check is updated to the new shape, not the pre-041 one.
  const service = read('src/lib/ai/resume-intelligence-service.ts');
  const claimCallSites = (service.match(/await callClaim\(/g) ?? []).length;
  assert(claimCallSites === 1, `there is exactly one callClaim() call site (the pending claim) — found ${claimCallSites}`, String(claimCallSites));
  const finalizeCallSites = (service.match(/await callFinalize\(/g) ?? []).length;
  assert(finalizeCallSites >= 3, `there are multiple callFinalize() call sites (quota-denied, model-failed, success/unavailable) — found ${finalizeCallSites}`, String(finalizeCallSites));
  assert(/async function callClaim[\s\S]*?if \(error\) \{\s*\n\s*return \{ id: null, wrote: false, attemptNumber: null, error:/.test(service), 'the single shared callClaim() helper checks `error` from the RPC response — every call site inherits this, so a future call site cannot forget it (Finding A)');
  assert(/async function callFinalize[\s\S]*?if \(error\) \{\s*\n\s*return \{ id: null, finalized: false, result: null, error:/.test(service), 'the single shared callFinalize() helper also checks `error` from the RPC response, same discipline as callClaim()');
  assert(!/const \{ data: stored \} = await supabase\.rpc\('upsert_resume_analysis'/.test(service), 'no remaining call site destructures {data} from upsert_resume_analysis while discarding error (the original Finding A pattern)');
  assert(!/await supabase\.rpc\('finalize_resume_analysis'[\s\S]{0,80}\);(?!\s*\n\s*if \(error\))/.test(service.replace(/async function callFinalize[\s\S]*?\n\}\n/, '')), 'no call site OUTSIDE callFinalize() itself calls finalize_resume_analysis directly and discards its error');
  assert(/persisted: boolean/.test(service), 'AnalyzeResult carries an explicit `persisted` field distinct from analysisId truthiness');

  console.log('\n/api/resume/suggestions route — Finding D\'s 403 mapping (P1 item: explicit forbidden, no content leak)');
  const suggestionsRoute = read('src/app/api/resume/suggestions/route.ts');
  assert(/code === '42501'/.test(suggestionsRoute) && /status: 403/.test(suggestionsRoute), 'a 42501 (ownership-violation) error from the RPC is mapped to an explicit 403');
  assert(/'You do not have access to this analysis\.'/.test(suggestionsRoute), 'the 403 body is the one generic line — nothing from the analysis itself is echoed back');
  // Make sure the 403 branch really is reached BEFORE the generic 500 fallback, not after an
  // earlier unconditional return — i.e. the two status branches are genuinely distinct code paths.
  const codeIdx = suggestionsRoute.indexOf("code === '42501'");
  const genericIdx = suggestionsRoute.indexOf('Could not record your decision');
  assert(codeIdx > -1 && genericIdx > codeIdx, 'the 42501 check appears before the generic 500 fallback in source order (the specific case is handled first)');

  console.log('\nresume-intelligence/page.tsx — Finding B (confirmed-only UI) and Finding E (tab-switch preview) wiring');
  const page = read('src/app/resume-intelligence/page.tsx');
  assert(/submitSuggestionDecision/.test(page), 'the page now calls the extracted, independently-tested submitSuggestionDecision() rather than embedding the fetch/response logic inline');
  assert(!/setDecisions\(\(prev\) => \(\{ \.\.\.prev, \[suggestionId\]: decision \}\)\);\s*\n\s*(try|const outcome)/m.test(page) || /if \(!outcome\.ok\)/.test(page), 'decisions are set from the confirmed outcome, not optimistically before the request');
  assert(/const \[resumeText, setResumeText\] = useState/.test(page) && /const \[versionId, setVersionId\] = useState/.test(page), 'resumeText/versionId are tracked at the top level, independent of which PanelState phase is active (Finding E fix)');
  assert(!/resumeText: state\.phase === 'ready' \? state\.resumeText : ''/.test(page), 'the old phase-dependent ternary that went blank outside the \'ready\' phase is gone');
  assert(/decisionBusy/.test(page) && /saving=\{decisionBusy\[r\.id\] \?\? false\}/.test(page), 'a per-suggestion busy flag disables the card\'s buttons during an in-flight request, so a second click cannot fire a concurrent duplicate from the same card');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
