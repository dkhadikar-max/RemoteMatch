/**
 * Translation-aware catalog sync — a finished translation must survive a sync cycle.
 * ==============================================================================
 * THE DEFECT (docs/phase-a-item-1b-spec-v2.md R1; docs/translation-overwrite-fix-scope.md):
 * both sync paths rewrote `title`/`description` from the provider feed for every row they saw. For a
 * translated row that text is the SOURCE language, so (a) with an unchanged feed the translated text was
 * silently reverted while `translation_status` stayed 'ok' (the row stayed public), and (b) with a changed
 * feed the new source text was written while the status stayed 'ok' — an untranslated listing leaked.
 *
 * THE RULE (decided by Deep, 2026-10-13: exact comparison, withdraw on change, both sync paths):
 *
 *   existing row                                             title/description          translation_status
 *   -------------------------------------------------------  -------------------------  -------------------
 *   not translated                                            written from the feed      unchanged   ('normal')
 *   translated, incoming text == the stored source text       KEPT (also content_hash)  unchanged   ('preserve')
 *   translated, incoming text differs from the source text    written from the feed      set to NULL ('withdraw')
 *
 * "Translated" = a non-English detected language, translation_status 'ok', and a recorded
 * translated_content_hash. "The stored source text" = original_title / original_description, which the
 * translation pass saves verbatim at translation time (they are exactly what the sync last wrote). The
 * comparison is EXACT, so a change anywhere in the text is detected — unlike content_hash, which covers only
 * company + title + the first 300 raw characters of the description. When original_* is missing (should not
 * happen for an 'ok' row) the rule falls back to the hash comparison rather than guessing.
 *
 * Why NULL on change: the public gate already hides a non-English row whose status is not 'ok' (fail-closed
 * contract, migration 028) and the translation pass already selects translation_status IS NULL rows, so a
 * changed listing disappears until it is re-translated, then returns by itself. No new state, no migration.
 * Why content_hash is also kept on 'preserve': the pass re-translates when content_hash != translated_content_hash,
 * and would then take the already-ENGLISH text as its source. With the text unchanged the hash must not move.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TranslationState {
  source_language?: string | null;
  translation_status?: string | null;
  translated_content_hash?: string | null;
  original_title?: string | null;
  original_description?: string | null;
}

export type TranslationDecision = 'normal' | 'preserve' | 'withdraw';

/** The columns every existing-row read needs (all short). */
export const TRANSLATION_STATE_COLUMNS = ['source_language', 'translation_status', 'translated_content_hash'] as const;

export function isTranslated(s: TranslationState | null | undefined): boolean {
  if (!s) return false;
  const lang = s.source_language;
  return typeof lang === 'string' && lang !== '' && lang !== 'en' && s.translation_status === 'ok' && typeof s.translated_content_hash === 'string' && s.translated_content_hash !== '';
}

export function decideTranslationUpdate(
  existing: TranslationState | null | undefined,
  incoming: { title: unknown; description: unknown; content_hash: unknown }
): TranslationDecision {
  if (!isTranslated(existing)) return 'normal';
  const e = existing as TranslationState;
  if (typeof e.original_title === 'string' && typeof e.original_description === 'string') {
    return e.original_title === incoming.title && e.original_description === incoming.description ? 'preserve' : 'withdraw';
  }
  // original_* missing on an 'ok' row: fall back to the hash rather than guess.
  return e.translated_content_hash === incoming.content_hash ? 'preserve' : 'withdraw';
}

/** Returns the field set to write for an EXISTING row, plus the extra column changes the decision requires. */
export function applyTranslationDecision<T extends Record<string, unknown>>(
  fields: T,
  decision: TranslationDecision
): { fields: Partial<T>; extra: { translation_status?: null } } {
  if (decision === 'preserve') {
    const { title: _t, description: _d, content_hash: _h, ...rest } = fields as Record<string, unknown>;
    void _t; void _d; void _h;
    return { fields: rest as Partial<T>, extra: {} };
  }
  if (decision === 'withdraw') return { fields, extra: { translation_status: null } };
  return { fields, extra: {} };
}

/** Rows whose stored source text must be loaded to decide: translated rows only (a small minority). */
export function needsOriginalText(s: TranslationState): boolean {
  return isTranslated(s) && (typeof s.original_title !== 'string' || typeof s.original_description !== 'string');
}

const ORIGINALS_CHUNK = 100; // 100 uuids ≈ 3.7 KB of query string, well under any URL limit

/**
 * Loads original_title / original_description for the given row ids (chunked). Only called for translated
 * rows, so the extra egress is (translated rows) × (source text) per sync — a few MB at the very most.
 */
export async function loadOriginalTexts(
  admin: SupabaseClient,
  ids: string[]
): Promise<{ byId: Map<string, { original_title: string | null; original_description: string | null }>; requests: number }> {
  const byId = new Map<string, { original_title: string | null; original_description: string | null }>();
  let requests = 0;
  for (let i = 0; i < ids.length; i += ORIGINALS_CHUNK) {
    const chunk = ids.slice(i, i + ORIGINALS_CHUNK);
    requests++;
    const res = await admin.from('opportunities').select('id, original_title, original_description').in('id', chunk);
    if (res.error) throw new Error(`Could not read stored source text: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{ id: string; original_title: string | null; original_description: string | null }>) {
      byId.set(r.id, { original_title: r.original_title, original_description: r.original_description });
    }
  }
  return { byId, requests };
}
