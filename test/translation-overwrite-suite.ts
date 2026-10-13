/**
 * Translation overwrite — the catalog sync must not undo a finished translation.
 * ==============================================================================
 * THE DEFECT (docs/phase-a-item-1b-spec-v2.md R1; docs/translation-overwrite-fix-scope.md): both sync paths
 * rewrote `title`/`description` from the feed for every row they saw. For a translated row that text is the
 * SOURCE language, so an unchanged feed silently reverted the translation while `translation_status` stayed
 * 'ok' (still public), and a changed feed wrote new source text under 'ok' — an untranslated listing leaked.
 *
 * THE RULE (src/lib/ingestion/translation-preservation.ts): a TRANSLATED row (non-English language, status 'ok',
 * hash recorded) keeps its translated title/description/content_hash when the incoming source text EXACTLY equals the
 * stored source text (original_*); when it differs anywhere — including past the first 300 characters that
 * content_hash covers — the new source text is written and translation_status is set to NULL, so the fail-closed
 * gate hides the row until the translation pass re-translates it. Every other row is written exactly as before.
 *
 * Acceptance criteria (Deep, 2026-10-13):
 *   AC1 untranslated rows still update normally          AC4 both sync paths behave identically
 *   AC2 unchanged source text keeps the translation,     AC5 a failed translation never makes untranslated
 *       other fields still refresh                           content public
 *   AC3 changed source text is withdrawn until           AC6 no migration / no unrelated behaviour change
 *       re-translation succeeds                              (the suite touches only synthetic rows, then removes them)
 *
 *  §0 pure   the decision table (translation-preservation.ts), every row incl. the tail-only edit and the hash fallback
 *  §1 real   the same scenarios through BOTH paths — legacy and the corrected path ('observe') — against a real
 *            database with isolated synthetic rows (source 'remotive', source_id 'tov…'), injected feeds, no live
 *            provider fetch, links on the reserved .invalid TLD (the check fails open -> active), then compared
 *  §2 pure   contentDiffers() on a translated row (observe/full must not rewrite it every cycle)
 *
 * Run: npx tsx --env-file=.env.migration.local test/translation-overwrite-suite.ts
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import { syncOpportunitiesToCatalog, type ProviderFetchResult } from '../src/lib/ingestion/catalog-sync';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';
import { buildContentFields, contentDiffers, type NormalizedOpp } from '../src/lib/ingestion/catalog-sync-plan';
import { decideTranslationUpdate, applyTranslationDecision, isTranslated } from '../src/lib/ingestion/translation-preservation';
import { getActiveOpportunities } from '../src/lib/ingestion/catalog-read';
import type { RawJobPayload } from '../src/lib/providers/types';

let passed = 0, failed = 0, skipped = 0;
function assert(ok: boolean, msg: string, detail?: string) {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
}

const EN_TITLE = (id: string) => `Backend Developer (m/f/d) Berlin ${id}`;
const EN_DESC = (id: string) => `We are looking for an experienced backend developer, position ${id}. `.repeat(8);

// A source text longer than 300 characters, so a TAIL-only edit (past what content_hash covers) is possible.
const srcDesc = (id: string, tail = '') => `Stelle ${id}. ${'Wir suchen einen erfahrenen Backend Entwickler für unser Team in Berlin. '.repeat(8)}${tail}`;
const MARK = 'ENDE-ABSCHNITT-NEU';
type Spec = { title?: string; description?: string; salaryMin?: number };
const mk = (prefix: string, id: string, s: Spec = {}): RawJobPayload => ({
  source: 'remotive', sourceId: `${prefix}${id}`, title: s.title ?? `Backend Entwickler (m/w/d) Berlin ${id}`, company: 'Tov Gmbh',
  description: s.description ?? srcDesc(id), officialUrl: `https://tov-suite.invalid/j/${prefix}${id}`, jobType: 'Full-time',
  publicationDate: new Date(Date.now() - 3600_000).toISOString(), ...(s.salaryMin ? { salaryMin: s.salaryMin, salaryMax: s.salaryMin + 1000, salaryCurrency: 'USD' } : {}),
});
const feed = (jobs: RawJobPayload[]): ProviderFetchResult => ({ outcomes: [{ sourceKey: 'remotive', success: true, jobCount: jobs.length }], successfulRaw: new Map([['remotive', jobs]]) });

function pure() {
  console.log('\n0. PURE — the decision table');
  const incoming = { title: 'T', description: 'D', content_hash: 'h1' };
  const tr = (o: any = {}) => ({ source_language: 'de', translation_status: 'ok', translated_content_hash: 'h1', original_title: 'T', original_description: 'D', ...o });
  assert(decideTranslationUpdate(undefined, incoming) === 'normal', 'no existing row -> normal');
  assert(decideTranslationUpdate({ source_language: null, translation_status: null, translated_content_hash: null }, incoming) === 'normal', 'not yet processed (NULL/NULL) -> normal');
  assert(decideTranslationUpdate({ source_language: 'en', translation_status: 'n/a', translated_content_hash: 'h1' }, incoming) === 'normal', 'English (n/a) -> normal');
  assert(decideTranslationUpdate(tr({ translation_status: 'error' }), incoming) === 'normal', "status 'error' -> normal (not a finished translation)");
  assert(decideTranslationUpdate(tr({ translation_status: null }), incoming) === 'normal', 'already withdrawn (NULL) -> normal');
  assert(decideTranslationUpdate(tr({ translated_content_hash: null }), incoming) === 'normal', 'no recorded hash -> not "translated" -> normal');
  assert(isTranslated(tr()) && !isTranslated(tr({ source_language: 'en' })) && !isTranslated(null), 'isTranslated agrees');
  assert(decideTranslationUpdate(tr(), incoming) === 'preserve', 'translated + identical source text -> preserve');
  assert(decideTranslationUpdate(tr(), { ...incoming, title: 'T2' }) === 'withdraw', 'translated + title changed -> withdraw');
  assert(decideTranslationUpdate(tr(), { ...incoming, description: 'D2' }) === 'withdraw', 'translated + description changed -> withdraw');
  const long = 'x'.repeat(400);
  assert(decideTranslationUpdate(tr({ original_description: long }), { ...incoming, description: long + ' tail' }) === 'withdraw', 'a TAIL-only edit (past char 300, same hash) is detected -> withdraw');
  assert(decideTranslationUpdate(tr({ original_title: null, original_description: null }), incoming) === 'preserve', 'original_* missing: falls back to the hash (equal -> preserve)');
  assert(decideTranslationUpdate(tr({ original_title: null, original_description: null }), { ...incoming, content_hash: 'h2' }) === 'withdraw', 'original_* missing: falls back to the hash (differs -> withdraw)');
  const f = { title: 'T', description: 'D', content_hash: 'h1', salary_min: 5 };
  const p = applyTranslationDecision(f, 'preserve');
  assert(!('title' in p.fields) && !('description' in p.fields) && !('content_hash' in p.fields) && (p.fields as any).salary_min === 5 && Object.keys(p.extra).length === 0, 'preserve drops title/description/content_hash only, keeps every other field');
  const w = applyTranslationDecision(f, 'withdraw');
  assert((w.fields as any).title === 'T' && w.extra.translation_status === null, 'withdraw writes the fields and sets translation_status NULL');
  assert(applyTranslationDecision(f, 'normal').fields === f, 'normal returns the fields untouched');
}

async function main() {
  pure();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) { console.log('  – SKIP §1: Supabase env incomplete'); skipped++; return finish(); }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const stamp = Date.now().toString(36);
  const prefixes: string[] = [];
  const finalStates: Record<string, Record<string, any>> = {};

  try {
    for (const mode of ['legacy', 'observe'] as const) {
      const PREFIX = `tov-${mode.slice(0, 1)}${stamp}-`;
      prefixes.push(PREFIX);
      const run = (jobs: RawJobPayload[]) => syncOpportunitiesToCatalog(feed(jobs), { mode, absenceScanSourceIdPrefix: PREFIX });
      const row = async (id: string) => (await admin.from('opportunities').select('*').eq('source_id', `${PREFIX}${id}`).single()).data as any;
      const visible = async (id: string) => (await getActiveOpportunities(anon, { translationSafe: true })).some((o) => o.sourceId === `${PREFIX}${id}`);
      const translate = async (id: string) => {
        const r = await row(id);
        const up = await admin.from('opportunities').update({
          title: EN_TITLE(id), description: EN_DESC(id), original_title: r.title, original_description: r.description,
          source_language: 'de', translation_status: 'ok', translated_content_hash: r.content_hash, translated_at: new Date().toISOString(), translation_model: 'test',
        }).eq('id', r.id);
        return !up.error;
      };
      const feed1 = () => [mk(PREFIX, 'A'), mk(PREFIX, 'B'), mk(PREFIX, 'D'), mk(PREFIX, 'E'), mk(PREFIX, 'F'), mk(PREFIX, 'G'), mk(PREFIX, 'U')];
      console.log(`\n1. REAL DATABASE — ${mode.toUpperCase()} path`);

      await run(feed1());
      const seeded = await Promise.all(['A', 'B', 'D', 'E', 'F', 'G', 'U'].map(row));
      assert(seeded.every((r) => r && r.status === 'active'), `${mode}: seeded 7 active rows through the real sync`, seeded.map((r) => r?.status).join(','));
      for (const id of ['A', 'B', 'D', 'E', 'G']) assert(await translate(id), `${mode}: simulated a finished translation for ${id}`);
      // F: a translation that FAILED (kept source text, language known, status error)
      await admin.from('opportunities').update({ source_language: 'de', translation_status: 'error' }).eq('id', (await row('F')).id);
      assert((await visible('A')) && !(await visible('F')), `${mode}: translated rows are public, the failed-translation row is hidden`);

      // cycle 2: A unchanged | B title changed | D description changed ONLY after char 300 | E only a non-text field changes
      //          F unchanged | G description changed | U (never translated) title changed
      await run([
        mk(PREFIX, 'A'), mk(PREFIX, 'B', { title: 'Backend Entwickler (m/w/d) Berlin B GEÄNDERT' }), mk(PREFIX, 'D', { description: srcDesc('D', ` ${MARK}`) }),
        mk(PREFIX, 'E', { salaryMin: 90000 }), mk(PREFIX, 'F'), mk(PREFIX, 'G', { description: srcDesc('G', ` ${MARK}`) }), mk(PREFIX, 'U', { title: 'Backend Entwickler (m/w/d) Berlin U GEÄNDERT' }),
      ]);
      const [a, b, d, e, f, g, u] = await Promise.all(['A', 'B', 'D', 'E', 'F', 'G', 'U'].map(row));

      // AC2
      assert(a.title === EN_TITLE('A') && a.description === EN_DESC('A'), `${mode} AC2: unchanged source text keeps the translated title and description`, `title now "${a.title}"`);
      assert(a.translation_status === 'ok' && a.source_language === 'de' && a.translated_content_hash === seeded[0].content_hash && a.original_title === seeded[0].title, `${mode} AC2: translation metadata and the stored source text are intact`);
      assert(e.title === EN_TITLE('E') && e.description === EN_DESC('E') && Number(e.salary_min) === 90000, `${mode} AC2: a NON-text change (salary) still refreshes on a preserved translated row`, `salary_min=${e.salary_min} title="${e.title}"`);
      assert(e.translation_status === 'ok', `${mode} AC2: ...and the row stays translated`);
      // AC3 (+ the tail-only edit that content_hash alone cannot see)
      assert(b.title.includes('GEÄNDERT') && b.translation_status === null, `${mode} AC3: a changed title writes the new source text and withdraws the row`, `title="${b.title}" status=${b.translation_status}`);
      assert(String(d.description).includes(MARK) && d.translation_status === null, `${mode} AC3: a TAIL-ONLY description edit (past char 300) is detected, written and withdrawn`, `status=${d.translation_status}`);
      assert(d.content_hash === seeded[2].content_hash, `${mode} AC3: (control) that tail edit did NOT change content_hash — the hash alone would have missed it`);
      assert(!(await visible('B')) && !(await visible('D')) && !(await visible('G')), `${mode} AC3: the withdrawn, untranslated listings are NOT public`);
      assert((await visible('A')) && (await visible('E')), `${mode} AC3: the preserved translated listings are still public`);
      // AC1
      assert(u.title.includes('GEÄNDERT') && u.translation_status === null && u.source_language === null, `${mode} AC1: an untranslated row updates normally`, `title="${u.title}"`);
      // AC5
      assert(f.translation_status === 'error' && !(await visible('F')), `${mode} AC5: a failed-translation row is not resurrected by a sync and stays hidden`);

      // the translation pass runs again: B re-translated OK, G's re-translation FAILS, D's pass failed at batch level (stays NULL)
      assert(await translate('B'), `${mode}: simulated a successful re-translation of B`);
      await admin.from('opportunities').update({ translation_status: 'error' }).eq('id', g.id);
      assert((await visible('B')) && !(await visible('G')) && !(await visible('D')), `${mode} AC3/AC5: B is public again; G (re-translation failed) and D (still pending) stay hidden`);

      // cycles 3 and 4 with the cycle-2 feed: stable, no flapping, B keeps its NEW translation
      const feed2 = () => [mk(PREFIX, 'A'), mk(PREFIX, 'B', { title: 'Backend Entwickler (m/w/d) Berlin B GEÄNDERT' }), mk(PREFIX, 'D', { description: srcDesc('D', ` ${MARK}`) }), mk(PREFIX, 'E', { salaryMin: 90000 }), mk(PREFIX, 'F'), mk(PREFIX, 'G', { description: srcDesc('G', ` ${MARK}`) }), mk(PREFIX, 'U', { title: 'Backend Entwickler (m/w/d) Berlin U GEÄNDERT' })];
      await run(feed2()); await run(feed2());
      const [a2, b2, d2, g2] = await Promise.all(['A', 'B', 'D', 'G'].map(row));
      assert(b2.title === EN_TITLE('B') && b2.translation_status === 'ok', `${mode} AC3: after re-translation, further syncs keep it (no flapping back to the source text)`, `title="${b2.title}" status=${b2.translation_status}`);
      assert(a2.title === EN_TITLE('A') && d2.translation_status === null && g2.translation_status === 'error', `${mode}: three more cycles leave A translated, D pending, G failed — no resurrection`);

      finalStates[mode] = Object.fromEntries(['A', 'B', 'D', 'E', 'F', 'G', 'U'].map((id) => [id, null]));
      for (const id of ['A', 'B', 'D', 'E', 'F', 'G', 'U']) { const r = await row(id); finalStates[mode][id] = { title: r.title, translation_status: r.translation_status, source_language: r.source_language, salary_min: r.salary_min, descHasMark: String(r.description).includes(MARK) }; }
    }

    console.log('\n1b. AC4 — both sync paths end in the same state');
    for (const id of ['A', 'B', 'D', 'E', 'F', 'G', 'U']) assert(JSON.stringify(finalStates.legacy[id]) === JSON.stringify(finalStates.observe[id]), `row ${id}: legacy and corrected path agree`, `${JSON.stringify(finalStates.legacy[id])} vs ${JSON.stringify(finalStates.observe[id])}`);

    console.log('\n2. PURE — contentDiffers on a translated row');
    const opp = normalizeOpportunity(mk('x-', 'A')) as unknown as NormalizedOpp;
    const incoming = buildContentFields(opp);
    const translatedExisting = { ...incoming, title: EN_TITLE('A'), description: EN_DESC('A'), original_title: incoming.title, original_description: incoming.description, source_language: 'de', translation_status: 'ok', translated_content_hash: incoming.content_hash };
    assert(contentDiffers(translatedExisting as any, incoming) === false, 'an unchanged translated row is NOT reported as changed (else observe/full rewrite it every cycle)');
    assert(contentDiffers({ ...translatedExisting, original_description: `${incoming.description} changed` } as any, incoming) === true, 'a source-text change on a translated row IS reported (so it is written and withdrawn)');
    assert(contentDiffers({ ...translatedExisting, quality_score: 1 } as any, incoming) === true, 'a non-text change on a translated row is still reported');
    const untranslated = { ...incoming, source_language: null, translation_status: null };
    assert(contentDiffers(untranslated as any, incoming) === false && contentDiffers({ ...untranslated, quality_score: 1 } as any, incoming) === true, 'controls: an untranslated row behaves exactly as before');
  } finally {
    await admin.from('opportunities').delete().like('source_id', 'tov-%');
    const left = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', 'tov-%');
    assert((left.count ?? 0) === 0, `AC6 cleanup: all synthetic rows removed (${left.count ?? 0} remain)`);
  }
  return finish();
}
function finish() { console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`); process.exit(failed ? 1 : 0); }
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
