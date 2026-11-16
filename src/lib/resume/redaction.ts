/**
 * Resume Intelligence — PII minimization before any model call.
 * docs/resume-intelligence-design.md §4/§10 decision 5 (Deep, 2026-10-17/18):
 * "Remove the candidate's name, email, phone, address and personal links
 * before sending resume text to the model." Applied to the text the MODEL
 * sees only — the original, unredacted text is what deterministic checks
 * (header presence, R1) and the final evidence-span mapping run against.
 *
 * Offsets are preserved: a quote the model returns against the redacted text
 * maps back to the same span in the original via the returned offset table,
 * so evidence verification (evidence-validation.ts, V2/V3) still works
 * against the real text.
 */

export type RedactionKind = 'EMAIL' | 'PHONE' | 'ADDRESS' | 'LINK' | 'NAME';

export interface RedactionSpan {
  kind: RedactionKind;
  originalStart: number;
  originalEnd: number;
  placeholder: string;
}

export interface RedactionResult {
  redactedText: string;
  spans: RedactionSpan[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s)]+|\b(?:linkedin\.com|github\.com)\/[^\s)]+/gi;
// A line that looks like a street address: a leading number followed by word(s), or a
// line containing common address markers (Street/St/Ave/Road/Apt/Suite) with a number.
const ADDRESS_LINE_RE = /^\s*\d{1,6}\s+[A-Za-z0-9.,'\s]{3,60}\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|blvd|boulevard|apt|suite|floor)\b.*$/gim;

/** A crude but conservative phone filter: require at least 7 digits total so a lone
 *  "2024" (a year) or "3" (a bullet count) is never swept up. */
function isPlausiblePhone(s: string): boolean {
  return (s.match(/\d/g) ?? []).length >= 7;
}

function collectMatches(re: RegExp, text: string, kind: RedactionKind, filter?: (s: string) => boolean): RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const matched = m[0];
    if (filter && !filter(matched)) continue;
    spans.push({ kind, originalStart: m.index, originalEnd: m.index + matched.length, placeholder: `[${kind}]` });
    if (matched.length === 0) re.lastIndex++; // guard against zero-width matches
  }
  return spans;
}

/** The candidate's declared full name, redacted wherever it appears verbatim (case-insensitive,
 *  whole-word). Short or empty names are skipped — too likely to over-match common words. */
function collectNameMatches(text: string, fullName: string | undefined | null): RedactionSpan[] {
  const name = (fullName ?? '').trim();
  if (name.length < 3) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'gi');
  return collectMatches(re, text, 'NAME');
}

/** Resolves overlapping spans (e.g. a phone-shaped run inside a longer address line) by
 *  keeping the one that starts first and is longest, dropping anything it fully contains. */
function resolveOverlaps(spans: RedactionSpan[]): RedactionSpan[] {
  const sorted = [...spans].sort((a, b) => a.originalStart - b.originalStart || b.originalEnd - a.originalEnd);
  const out: RedactionSpan[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.originalStart >= lastEnd) {
      out.push(s);
      lastEnd = s.originalEnd;
    }
  }
  return out;
}

export function redactForModel(text: string, fullName?: string | null): RedactionResult {
  const spans = resolveOverlaps([
    ...collectMatches(EMAIL_RE, text, 'EMAIL'),
    ...collectMatches(LINK_RE, text, 'LINK'),
    ...collectMatches(ADDRESS_LINE_RE, text, 'ADDRESS'),
    ...collectMatches(PHONE_RE, text, 'PHONE', isPlausiblePhone),
    ...collectNameMatches(text, fullName),
  ]);

  let redacted = '';
  let cursor = 0;
  for (const s of spans) {
    redacted += text.slice(cursor, s.originalStart) + s.placeholder;
    cursor = s.originalEnd;
  }
  redacted += text.slice(cursor);

  return { redactedText: redacted, spans };
}

/** Maps an offset in the REDACTED text back to the original text's offset, accounting for the
 *  length delta each prior placeholder introduced. Used to resolve a model-returned quote that
 *  the server re-finds inside the redacted text (evidence-validation.ts). */
export function mapRedactedOffsetToOriginal(spans: RedactionSpan[], redactedOffset: number): number {
  let delta = 0; // redacted length so far minus original length so far, for spans before this offset
  let runningRedactedPos = 0;
  let runningOriginalPos = 0;
  for (const s of spans) {
    const gapLen = s.originalStart - runningOriginalPos;
    const redactedGapEnd = runningRedactedPos + gapLen;
    if (redactedOffset <= redactedGapEnd) {
      return runningOriginalPos + (redactedOffset - runningRedactedPos);
    }
    const placeholderEnd = redactedGapEnd + s.placeholder.length;
    if (redactedOffset <= placeholderEnd) {
      // Inside a placeholder itself — map to the start of the original span (never a reconstructed value).
      return s.originalStart;
    }
    runningRedactedPos = placeholderEnd;
    runningOriginalPos = s.originalEnd;
  }
  return runningOriginalPos + (redactedOffset - runningRedactedPos);
}

/** True if a string still contains an un-redacted-looking placeholder reference that the model
 *  echoed back as if it had reconstructed the real value — evidence-validation.ts V3 rejects
 *  output containing one. */
export function containsPlaceholder(s: string): boolean {
  return /\[(EMAIL|PHONE|ADDRESS|LINK|NAME)\]/.test(s);
}
