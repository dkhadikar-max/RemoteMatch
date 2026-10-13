/**
 * Translation pass — response-shape validation and per-row failure isolation.
 * ==============================================================================
 * Regression suite for the defect where ONE malformed Gemini result (a missing /
 * null / wrongly-typed `translatedTitle`) reached `.trim()`, threw a TypeError
 * out of the translation pass, and made POST /api/opportunities/sync return 500
 * after the catalog rows were already written (reconciliation skipped).
 *
 * NO LIVE GEMINI CALLS. Every model response here is canned and injected
 * (`generate` on translateJobBatchWithGemini, `translate` on processGeminiBatch /
 * translatePendingOpportunities). GEMINI_API_KEY is deliberately removed for the
 * run, so an accidental real call would throw instead of spending free-tier quota.
 *
 *  §1 parseTranslationResponse   shape validation, element by element
 *  §2 validators                 non-strings are { valid: false }, never a throw
 *  §3 translateJobBatchWithGemini  the injected-generator path, rejects logged w/o content
 *  §4 processGeminiBatch         mixed valid/invalid batches, retries, write failures
 *  §5 real database              the whole pass against live rows (isolated, cleaned up)
 *
 * Run: npx tsx --env-file=.env.migration.local test/translation-isolation-suite.ts
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
delete process.env.GEMINI_API_KEY; // see header: a real call must be impossible
delete process.env.DEEPL_API_KEY;

import { createClient } from '@supabase/supabase-js';
import {
  parseTranslationResponse,
  translateJobBatchWithGemini,
  type BatchTranslationOutput,
} from '../src/lib/translation/gemini-translator';
import { validateTranslatedTitle, validateTranslatedDescription, validateTranslationPair } from '../src/lib/translation/validation';
import { processGeminiBatch, translatePendingOpportunities, type PendingRow } from '../src/lib/translation/translate-pending';

let passed = 0, failed = 0, skipped = 0;
const assert = (ok: boolean, msg: string, detail?: string) => {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; } else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
};
const skip = (m: string) => { skipped++; console.log(`  – SKIP: ${m}`); };
const throwsAsync = async (fn: () => Promise<unknown> | unknown): Promise<string | null> => { try { await fn(); return null; } catch (e) { return (e as Error).message; } };

// Quiet the pass's own warn/error logging during the run; keep it available to inspect.
const logs: string[] = [];
const origWarn = console.warn, origError = console.error, origLog = console.log;
const quiet = () => { console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); }; console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); }; };
const loud = () => { console.warn = origWarn; console.error = origError; };

const GOOD = (id: string, lang = 'de', over: Partial<Record<string, unknown>> = {}) => ({
  id, detectedLanguage: lang,
  translatedTitle: `Translated title for ${id}`,
  translatedDescription: `This is the English translation of the description for ${id}, long enough to pass the length guard comfortably.`,
  ...over,
});
const ORIGINAL_DESCRIPTION = 'Dies ist die deutsche Beschreibung der Stelle, lang genug für die Längenprüfung des Validators hier.';

async function main() {
  // ===========================================================================
  console.log('\n1. parseTranslationResponse — shape validation, element by element');
  {
    const ok = parseTranslationResponse(JSON.stringify([GOOD('a'), GOOD('b', 'fr')]));
    assert(ok.outputs.length === 2 && ok.rejected.length === 0 && ok.outputs[1].detectedLanguage === 'fr', 'a well-formed response passes through untouched');
    assert(parseTranslationResponse('[]').outputs.length === 0, 'an empty array is a valid, empty result');

    const fields = ['id', 'detectedLanguage', 'translatedTitle', 'translatedDescription'] as const;
    const badValues: Array<[string, unknown]> = [['missing', undefined], ['null', null], ['number', 42], ['boolean', true], ['object', { x: 1 }], ['array', ['t']]];
    for (const field of fields) {
      for (const [label, value] of badValues) {
        const el: Record<string, unknown> = { ...GOOD('row-1') };
        if (value === undefined) delete el[field]; else el[field] = value;
        const r = parseTranslationResponse(JSON.stringify([GOOD('first'), el, GOOD('last')]));
        const good = r.outputs.map((o) => o.id).join();
        if (!(r.rejected.length === 1 && r.rejected[0].index === 1 && good === 'first,last')) {
          assert(false, `${field} = ${label} is rejected on its own and the neighbours survive`, `rejected=${JSON.stringify(r.rejected)} kept=${good}`);
        }
      }
    }
    assert(true, 'for each of the 4 required fields × {missing, null, number, boolean, object, array}: exactly that element is rejected and its neighbours are kept (24 cases)');

    const nonObjects = parseTranslationResponse(JSON.stringify([null, 'text', 7, ['x'], true, GOOD('survivor')]));
    assert(nonObjects.rejected.length === 5 && nonObjects.outputs.length === 1 && nonObjects.outputs[0].id === 'survivor', 'elements that are null / a string / a number / an array / a boolean are rejected; the valid one survives');
    const empties = parseTranslationResponse(JSON.stringify([GOOD('e1', ''), GOOD('e2', '   '), { ...GOOD('x'), id: '' }, GOOD('fine')]));
    assert(empties.rejected.length === 3 && empties.outputs.map((o) => o.id).join() === 'fine', 'an empty id or an empty/blank detectedLanguage is rejected');
    const dup = parseTranslationResponse(JSON.stringify([GOOD('same', 'de', { translatedTitle: 'FIRST' }), GOOD('same', 'de', { translatedTitle: 'SECOND' })]));
    assert(dup.outputs.length === 1 && dup.outputs[0].translatedTitle === 'FIRST' && dup.rejected.length === 1, 'a repeated id keeps the first valid element');
    const emptyStrings = parseTranslationResponse(JSON.stringify([GOOD('s', 'de', { translatedTitle: '', translatedDescription: '' })]));
    assert(emptyStrings.outputs.length === 1 && emptyStrings.rejected.length === 0, 'empty translated STRINGS are a valid shape (validateTranslationPair rejects them as too short later)');
    const extra = parseTranslationResponse(JSON.stringify([{ ...GOOD('x1'), confidence: 0.9, notes: 'ignored' }]));
    assert(extra.outputs.length === 1 && !('confidence' in extra.outputs[0]), 'extra keys are dropped, not passed along');

    for (const [label, text] of [['empty string', ''], ['truncated array', '[{"id":"a","detectedLanguage":"de","translatedTi'], ['not JSON', 'Sorry, I cannot translate that.'], ['bare brace', '{'], ['trailing comma', '[{"id":"a"},]'], ['markdown fenced', '```json\n[]\n```']] as const) {
      const msg = await throwsAsync(() => parseTranslationResponse(text));
      assert(!!msg && /Failed to parse JSON/.test(msg), `malformed JSON (${label}) throws a descriptive error (whole response unusable)`, msg ?? 'did not throw');
    }
    for (const [label, text] of [['object', '{"id":"a"}'], ['string', '"hello"'], ['number', '12'], ['null', 'null'], ['boolean', 'true']] as const) {
      const msg = await throwsAsync(() => parseTranslationResponse(text));
      assert(!!msg && /Expected an array/.test(msg), `valid JSON that is not an array (${label}) throws "Expected an array"`, msg ?? 'did not throw');
    }
    for (const bad of [undefined, null, 5, {}, []]) {
      const msg = await throwsAsync(() => parseTranslationResponse(bad as unknown));
      assert(!!msg && /not a string/.test(msg), `non-string response text (${JSON.stringify(bad) ?? 'undefined'}) throws`, msg ?? 'did not throw');
    }
    const secret = 'SECRET-MODEL-OUTPUT-xyz-should-never-be-logged';
    const leak = parseTranslationResponse(JSON.stringify([{ id: 'r1', detectedLanguage: 'de', translatedTitle: { v: secret }, translatedDescription: 'ok ok ok ok ok' }]));
    assert(leak.rejected.length === 1 && !JSON.stringify(leak.rejected).includes(secret), 'a rejection records the field and the reason, never the model text');
  }

  // ===========================================================================
  console.log('\n2. validators — non-string input is { valid: false }, never a TypeError');
  {
    for (const bad of [undefined, null, 0, 12, true, {}, [], () => 1] as unknown[]) {
      let r: any, threw = false;
      try { r = validateTranslatedTitle(bad as string); } catch { threw = true; }
      assert(!threw && r?.valid === false && /not a string/.test(r?.reason ?? ''), `validateTranslatedTitle(${typeof bad === 'function' ? 'function' : JSON.stringify(bad) ?? 'undefined'}) -> { valid: false }`);
      let r2: any, threw2 = false;
      try { r2 = validateTranslatedDescription(bad as string, ORIGINAL_DESCRIPTION); } catch { threw2 = true; }
      assert(!threw2 && r2?.valid === false && /not a string/.test(r2?.reason ?? ''), `validateTranslatedDescription(${typeof bad === 'function' ? 'function' : JSON.stringify(bad) ?? 'undefined'}) -> { valid: false }`);
    }
    let pairOk = true;
    for (const [t, d] of [[undefined, 'x'], ['Valid Title', undefined], [null, null], [5, 6]] as Array<[unknown, unknown]>) {
      try { const r = validateTranslationPair(t as string, d as string, ORIGINAL_DESCRIPTION); if (r.valid) pairOk = false; } catch { pairOk = false; }
    }
    assert(pairOk, 'validateTranslationPair never throws and never passes a non-string pair');
    assert(validateTranslatedDescription('A perfectly fine English description of reasonable length for this role.', undefined as unknown as string).valid === true, 'a missing ORIGINAL description does not turn the length comparison into a crash');
    assert(validateTranslationPair('Senior Engineer', 'This is the English translation of the description, long enough to pass the guard comfortably.', ORIGINAL_DESCRIPTION).valid === true, 'a good pair still validates (behavior unchanged for valid input)');
    assert(validateTranslatedTitle('', undefined).valid === false && validateTranslatedTitle('   ', undefined).valid === false, 'empty / blank strings are still rejected as too short');
  }

  // ===========================================================================
  console.log('\n3. translateJobBatchWithGemini — injected generator (no network, no key)');
  {
    const jobs = [{ id: 'j1', title: 'Entwickler', description: ORIGINAL_DESCRIPTION }, { id: 'j2', title: 'Designer', description: ORIGINAL_DESCRIPTION }];
    let prompt = '';
    quiet();
    const out = await translateJobBatchWithGemini(jobs, async (p) => { prompt = p; return JSON.stringify([GOOD('j1'), { id: 'j2', detectedLanguage: 'de', translatedTitle: null, translatedDescription: 'x' }]); });
    loud();
    assert(out.length === 1 && out[0].id === 'j1', 'only the well-formed result is returned; the malformed one is dropped');
    assert(prompt.includes('"id": "j1"') && prompt.includes('"id": "j2"'), 'the prompt still carries the input ids');
    const warned = logs.filter((l) => /malformed element/.test(l));
    assert(warned.length === 1 && /#1\(j2\)/.test(warned[0]) && /translatedTitle/.test(warned[0]), 'the rejection is logged with index, id and reason');
    assert((await translateJobBatchWithGemini([], async () => { throw new Error('must not be called'); })).length === 0, 'an empty job list returns [] without calling the model');
    const keyErr = await throwsAsync(() => translateJobBatchWithGemini(jobs));
    assert(!!keyErr && /GEMINI_API_KEY is not configured/.test(keyErr), 'with no key and no injected generator it throws before any network call (proves tests cannot reach Gemini)');
    const genErr = await throwsAsync(() => translateJobBatchWithGemini(jobs, async () => { throw new Error('429 quota'); }));
    assert(genErr === '429 quota', 'a generator failure propagates to the caller (which retries, then records the rows as errors)');
  }

  // ===========================================================================
  console.log('\n4. processGeminiBatch — mixed batches, retries, write failures (fake database)');
  {
    type Update = { id: string; patch: Record<string, any> };
    const mkAdmin = (opts: { failIds?: Set<string>; throwIds?: Set<string> } = {}) => {
      const updates: Update[] = [];
      const admin: any = {
        from: () => ({
          update: (patch: Record<string, any>) => ({
            eq: async (_col: string, id: string) => {
              if (opts.throwIds?.has(id)) throw new Error('network down');
              if (opts.failIds?.has(id)) return { error: { message: 'row is locked' } };
              updates.push({ id, patch });
              return { error: null };
            },
          }),
        }),
      };
      return { admin, updates };
    };
    const rows = (n: number, over: Partial<PendingRow> = {}): PendingRow[] =>
      Array.from({ length: n }, (_, i) => ({ uuid: `r${i + 1}`, title: `Titel ${i + 1}`, description: ORIGINAL_DESCRIPTION, content_hash: `h${i + 1}`, translation_status: null, translated_content_hash: null, ...over }));
    const viaGenerator = (responses: Array<string | Error>) => {
      let call = 0;
      const translate = (jobs: any) => translateJobBatchWithGemini(jobs, async () => { const r = responses[Math.min(call++, responses.length - 1)]; if (r instanceof Error) throw r; return r; });
      return { translate, calls: () => call };
    };
    const statusOf = (updates: Update[], id: string) => updates.filter((u) => u.id === id).map((u) => u.patch.translation_status).join();

    // 4a. all valid
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([JSON.stringify([1, 2, 3, 4].map((i) => GOOD(`r${i}`, 'de', { translatedTitle: `  Title ${i}  ` })))]);
      quiet(); const res = await processGeminiBatch(admin, rows(4), t.translate); loud();
      assert(res.join() === 'translated,translated,translated,translated' && updates.every((u) => u.patch.translation_status === 'ok'), '4a: an all-valid batch translates every row');
      assert(updates[0].patch.title === 'Title 1' && updates[0].patch.original_title === 'Titel 1' && updates[0].patch.source_language === 'de', '4a: title is trimmed, the original is preserved, the language recorded');
    }
    // 4b. THE regression: mixed valid/invalid -> exactly the bad rows error, everything after still runs
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([JSON.stringify([
        GOOD('r1'),                                                              // valid
        { id: 'r2', detectedLanguage: 'de', translatedDescription: 'x'.repeat(60) }, // translatedTitle MISSING
        { ...GOOD('r3'), translatedDescription: null },                          // description NULL
        { ...GOOD('r4'), translatedTitle: 12345 },                               // title WRONG TYPE
        GOOD('r5', 'en'),                                                        // valid English
        GOOD('r6'),                                                              // valid, AFTER the bad ones
      ])]);
      quiet(); const res = await processGeminiBatch(admin, rows(6), t.translate); loud();
      assert(res.join() === 'translated,error,error,error,english,translated', `4b: mixed batch -> bad rows are errors, valid rows before AND after them are processed (${res.join()})`);
      assert(statusOf(updates, 'r2') === 'error' && statusOf(updates, 'r3') === 'error' && statusOf(updates, 'r4') === 'error', '4b: each malformed row is recorded as translation_status = error in the database');
      assert(statusOf(updates, 'r1') === 'ok' && statusOf(updates, 'r6') === 'ok' && statusOf(updates, 'r5') === 'n/a', '4b: valid rows are written ok / n/a');
      assert(updates.filter((u) => ['r2', 'r3', 'r4'].includes(u.id)).every((u) => Object.keys(u.patch).join() === 'translation_status'), '4b: an error row is touched ONLY in translation_status (title/description are never overwritten)');
    }
    // 4c. response missing a row's id entirely / extra unknown ids
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([JSON.stringify([GOOD('r1'), GOOD('someone-else'), GOOD('r3')])]);
      quiet(); const res = await processGeminiBatch(admin, rows(3), t.translate); loud();
      assert(res.join() === 'translated,error,translated' && statusOf(updates, 'r2') === 'error', '4c: a row the model left out is an error; an unknown id in the response is ignored');
    }
    // 4d. whole response unusable (malformed JSON) -> retried once, then the rows are LEFT PENDING (not marked
    //     error: 'error' rows are hidden from every read path, and batch failures are routine on the free tier)
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator(['{"id": "r1", "detectedLa', 'still not json']);
      quiet(); const res = await processGeminiBatch(admin, rows(3), t.translate); loud();
      assert(t.calls() === 2, '4d: malformed JSON is attempted twice (one retry), as before');
      assert(res.join() === 'deferred,deferred,deferred' && updates.length === 0, '4d: after the retries the rows are DEFERRED — nothing is written, nothing throws, they stay pending for the next pass');
    }
    // 4d2. the generator keeps failing (quota / network) -> deferred, never error
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([new Error('429 quota exceeded'), new Error('429 quota exceeded')]);
      quiet(); const res = await processGeminiBatch(admin, rows(4), t.translate); loud();
      assert(res.join() === 'deferred,deferred,deferred,deferred' && updates.length === 0, '4d2: a quota / network failure defers the batch — rows are NOT marked error (which would hide them)');
    }
    // 4d3. a valid response in which EVERY element is malformed carries nothing usable -> deferred
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([JSON.stringify([{ id: 'r1' }, { id: 'r2', detectedLanguage: 'de' }, null])]);
      quiet(); const res = await processGeminiBatch(admin, rows(3), t.translate); loud();
      assert(res.join() === 'deferred,deferred,deferred' && updates.length === 0, '4d3: a response with ZERO usable elements (systematic malformation) defers the whole batch instead of hiding it');
    }
    // 4d4. an empty array for a non-empty batch -> deferred
    {
      const { admin, updates } = mkAdmin();
      quiet(); const res = await processGeminiBatch(admin, rows(2), viaGenerator(['[]']).translate); loud();
      assert(res.join() === 'deferred,deferred' && updates.length === 0, '4d4: an empty result array defers the batch');
    }
    // 4e. transient failure then success on the retry
    {
      const { admin } = mkAdmin();
      const t = viaGenerator([new Error('503 overloaded'), JSON.stringify([GOOD('r1'), GOOD('r2')])]);
      quiet(); const res = await processGeminiBatch(admin, rows(2), t.translate); loud();
      assert(t.calls() === 2 && res.join() === 'translated,translated', '4e: a transient generator failure is retried and the retry succeeds');
    }
    // 4f. fail-closed on language: a result without a usable detectedLanguage must NOT become "English"
    {
      const { admin, updates } = mkAdmin();
      const t = viaGenerator([JSON.stringify([{ id: 'r1', translatedTitle: 'T title', translatedDescription: 'x'.repeat(60) }, GOOD('r2', ''), GOOD('r3')])]);
      quiet(); const res = await processGeminiBatch(admin, rows(3), t.translate); loud();
      assert(res.join() === 'error,error,translated' && !updates.some((u) => u.patch.translation_status === 'n/a'), '4f: a missing / blank detectedLanguage is an error — never silently treated as English (n/a)');
    }
    // 4g. validation failures (not shape): too short, hallucinated salary
    {
      const { admin } = mkAdmin();
      const t = viaGenerator([JSON.stringify([GOOD('r1', 'de', { translatedTitle: 'x' }), GOOD('r2', 'de', { translatedDescription: 'Earn $250,000 per year working with us, a long enough text to pass length.' }), GOOD('r3')])]);
      quiet(); const res = await processGeminiBatch(admin, rows(3), t.translate); loud();
      assert(res.join() === 'error,error,translated', '4g: content-validation failures are per-row errors; the next row still translates');
    }
    // 4h. defense in depth: a translator that bypasses the parse layer and returns raw junk
    {
      const { admin, updates } = mkAdmin();
      const junk: any = [
        { id: 'r1', detectedLanguage: 'de', translatedTitle: undefined, translatedDescription: undefined },
        null, 'string', 7,
        { id: 'r3', detectedLanguage: 'de', translatedTitle: 'Valid Title', translatedDescription: 'A valid and sufficiently long English description for the row.' },
      ];
      quiet(); const res = await processGeminiBatch(admin, rows(3), async () => junk); loud();
      assert(res.join() === 'error,error,translated', `4h: raw junk straight from a translator is still isolated per row, no throw (${res.join()})`);
      assert(statusOf(updates, 'r1') === 'error', '4h: the junk row is recorded as an error');
    }
    // 4i. an unexpected throw while handling ONE row (a hostile getter) is caught for that row only
    {
      const { admin, updates } = mkAdmin();
      const hostile: any = { id: 'r2' };
      Object.defineProperty(hostile, 'detectedLanguage', { get() { throw new Error('boom from getter'); } });
      quiet(); const res = await processGeminiBatch(admin, rows(3), async () => [GOOD('r1') as any, hostile, GOOD('r3') as any]); loud();
      assert(res.join() === 'translated,error,translated' && statusOf(updates, 'r2') === 'error', '4i: an unexpected exception inside one row is caught: that row errors, rows around it are processed');
    }
    // 4j. database write failures
    {
      const { admin, updates } = mkAdmin({ failIds: new Set(['r1']), throwIds: new Set(['r2']) });
      const t = viaGenerator([JSON.stringify([GOOD('r1'), GOOD('r2'), GOOD('r3'), GOOD('r4', 'en')])]);
      quiet(); const res = await processGeminiBatch(admin, rows(4), t.translate); loud();
      assert(res.join() === 'error,error,translated,english', `4j: a refused / throwing database write is an ERROR for that row (not counted as translated); the rest succeed (${res.join()})`);
      assert(updates.some((u) => u.id === 'r3') && updates.some((u) => u.id === 'r4'), '4j: later rows were still written');
    }
    // 4k. retranslation flag
    {
      const { admin } = mkAdmin();
      const t = viaGenerator([JSON.stringify([GOOD('r1'), GOOD('r2')])]);
      const rs = [{ ...rows(1)[0], translation_status: 'ok', translated_content_hash: 'OLD', content_hash: 'NEW' }, ...rows(2).slice(1)];
      quiet(); const res = await processGeminiBatch(admin, rs, t.translate); loud();
      assert(res.join() === 'retranslated,translated', '4k: a changed content hash on an already-translated row is reported as retranslated');
    }
  }

  // ===========================================================================
  console.log('\n5. real database — the whole pass, with canned model responses');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    skip('Supabase env incomplete');
  } else {
    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const PREFIX = `transl-iso-${Date.now().toString(36)}-`;
    const N = 25; // 3 batches of 10 / 10 / 5
    const ids = Array.from({ length: N }, (_, i) => `${PREFIX}${String(i).padStart(2, '0')}`);
    const mk = (id: string, i: number) => ({
      source: 'remotive', source_id: id, type: 'job', title: `Entwickler ${i}`, company: 'Iso Test Co', company_logo: null, description: ORIGINAL_DESCRIPTION + ` #${i}`,
      source_url: 'https://example.com', official_url: 'https://example.com/apply', canonical_url_hash: `h-${id}`, content_hash: `c-${id}`, employment_type: 'Full-time',
      remote_type: 'Worldwide', eligible_countries: [], excluded_countries: [], timezone_requirements: [], required_skills: [], explicit_remote_scope: 'explicit_worldwide',
      status: 'active', posted_at: new Date().toISOString(), first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0,
    });
    try {
      for (let i = 0; i < N; i += 25) {
        const { error } = await db.from('opportunities').insert(ids.slice(i, i + 25).map((id, k) => mk(id, i + k)));
        if (error) { assert(false, 'seed', error.message); return finish(); }
      }
      const { data: seeded } = await db.from('opportunities').select('id, source_id').like('source_id', `${PREFIX}%`).order('source_id');
      const uuidBySource = new Map((seeded ?? []).map((r: any) => [r.source_id, r.id as string]));
      const { count: pendingBefore } = await db.from('opportunities').select('id', { count: 'exact', head: true }).eq('status', 'active').is('translation_status', null);
      assert(uuidBySource.size === N && pendingBefore === N, `seeded ${N} pending rows and they are the ONLY pending rows in the database (${pendingBefore})`);
      const sourceOf = new Map(Array.from(uuidBySource.entries()).map(([s, u]) => [u, s]));

      // Canned model: per batch call, behave differently.
      //   call 1 (rows 0-9):   mixed — good, missing title, null desc, wrong type, English, good…
      //   calls 2 & 3 (rows 10-19, the batch + its retry): the model response is NOT JSON at all
      //   call 4 (rows 20-24): fully valid
      let call = 0;
      const batchIds: string[][] = []; // the uuids the fake model received on each call (the DB's row order is not guaranteed)
      const translate = async (jobs: Array<{ id: string; title: string; description: string }>): Promise<BatchTranslationOutput[]> => {
        call++;
        batchIds.push(jobs.map((j) => j.id));
        const text = (() => {
          if (call === 1) {
            return JSON.stringify(jobs.map((j, k) => {
              if (k === 1) { const { translatedTitle, ...rest } = GOOD(j.id) as any; return rest; }
              if (k === 3) return { ...GOOD(j.id), translatedDescription: null };
              if (k === 5) return { ...GOOD(j.id), translatedTitle: { nested: 'object' } };
              if (k === 7) return GOOD(j.id, 'en');
              return GOOD(j.id);
            }));
          }
          if (call === 2 || call === 3) return 'Sorry — I am unable to return JSON for this request.';
          return JSON.stringify(jobs.map((j) => GOOD(j.id)));
        })();
        return translateJobBatchWithGemini(jobs, async () => text);
      };

      quiet();
      let summary: any, threw: string | null = null;
      try { summary = await translatePendingOpportunities({ translate }); } catch (e) { threw = (e as Error).message; }
      loud();
      assert(threw === null && !!summary, `the pass returned normally instead of throwing (${threw ?? 'no throw'})`);
      assert(summary?.provider === 'gemini' && summary?.examined === N, `it examined all ${N} rows through the Gemini path (provider=${summary?.provider}, examined=${summary?.examined})`);
      assert(call === 4, `the model was asked 4 times: batch 1, batch 2 + its retry, batch 3 (${call}) — a failing batch does NOT stop later batches`);

      const { data: after } = await db.from('opportunities').select('id, source_id, title, description, translation_status, source_language, original_title').like('source_id', `${PREFIX}%`).order('source_id');
      const row = (uuid: string) => (after ?? []).find((r: any) => r.id === uuid) as any;
      const [b1, b2, b3] = [batchIds[0], batchIds[1], batchIds[3]];
      assert(b1?.length === 10 && b2?.length === 10 && JSON.stringify(batchIds[1]) === JSON.stringify(batchIds[2]) && b3?.length === 5, 'the pass sent batches of 10 / 10 (twice: the retry) / 5');
      const st = (u: string) => row(u)?.translation_status;
      assert([0, 2, 4, 6, 8, 9].every((k) => st(b1[k]) === 'ok') && st(b1[7]) === 'n/a', 'batch 1: the valid rows are ok, the English row is n/a');
      assert([1, 3, 5].every((k) => st(b1[k]) === 'error'), 'batch 1: the three malformed rows (missing / null / wrong type) are recorded as error');
      assert(b2.every((u) => st(u) === null), 'batch 2 (response was not JSON): all 10 rows are left PENDING (status NULL) — not marked error, so they are neither hidden nor lost');
      assert(b3.every((u) => st(u) === 'ok'), 'batch 3 (after the failed batch) was still fully processed: all ok');
      const okRow = row(b1[0]);
      assert(okRow.title.startsWith('Translated title for ') && /^Entwickler \d+$/.test(okRow.original_title) && okRow.source_language === 'de', 'a translated row got the English title, kept its original, and recorded the language');
      const errRow = row(b1[1]);
      assert(/^Entwickler \d+$/.test(errRow.title) && errRow.description.startsWith('Dies ist'), 'an error row keeps its ORIGINAL title and description (nothing overwritten)');
      assert(summary.translated === 6 + 5 && summary.englishDetected === 1 && summary.errors === 3 && summary.deferred === 10, `summary counts match the database: translated=${summary?.translated} english=${summary?.englishDetected} errors=${summary?.errors} deferred=${summary?.deferred}`);

      // A SECOND pass (the model healthy this time): the 10 deferred rows are picked up again and succeed;
      // the 3 definitively-errored rows are not re-sent (error is terminal for that content).
      const secondCalls: string[][] = [];
      quiet();
      const summary2 = await translatePendingOpportunities({ translate: async (jobs) => { secondCalls.push(jobs.map((j) => j.id)); return translateJobBatchWithGemini(jobs, async () => JSON.stringify(jobs.map((j) => GOOD(j.id)))); } });
      loud();
      const resent = new Set(secondCalls.flat());
      assert(summary2.examined === 10 && b2.every((u) => resent.has(u)) && !b1.some((u) => resent.has(u)) && !b3.some((u) => resent.has(u)), `second pass re-sends exactly the 10 deferred rows (examined=${summary2.examined}) and nothing else`);
      const { data: after2 } = await db.from('opportunities').select('id, translation_status').like('source_id', `${PREFIX}%`);
      assert(b2.every((u) => (after2 ?? []).find((r: any) => r.id === u)?.translation_status === 'ok'), 'the previously-deferred rows are now translated (ok): a transient failure costs nothing permanent');
      assert([1, 3, 5].every((k) => (after2 ?? []).find((r: any) => r.id === b1[k])?.translation_status === 'error'), 'the 3 definitively-errored rows remain error (terminal, hidden)');
    } finally {
      const { error } = await db.from('opportunities').delete().like('source_id', `${PREFIX}%`);
      const { count } = await db.from('opportunities').select('id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
      assert(!error && (count ?? 0) === 0, `cleanup: all synthetic rows removed (${count ?? 0} remain)`, error?.message);
    }
  }

  return finish();
}

function finish() {
  loud();
  origLog(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { loud(); console.error('SUITE ERROR:', e); process.exit(1); });
