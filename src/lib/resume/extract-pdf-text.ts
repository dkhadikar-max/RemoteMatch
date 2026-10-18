/**
 * Client-only PDF text extraction for the onboarding resume step. Loaded via
 * a dynamic import so pdfjs-dist (a large, browser-oriented library) is never
 * pulled into any server bundle. The worker script and standard-fonts data
 * are served from public/pdf.worker.min.mjs and public/standard_fonts/ (both
 * copied from the installed package at the same pinned version) rather than
 * a CDN, so extraction doesn't depend on an external host being reachable or
 * version-matched. standardFontDataUrl matters even for text-only
 * extraction: without it, pdfjs can't resolve glyph metrics for a PDF's
 * non-embedded standard fonts (Helvetica, Times, etc. — the common case for
 * resumes exported from Word/Google Docs) and silently truncates the
 * extracted text partway through — found via a real generated-PDF test
 * during development, not from the docs.
 *
 * pdfjs-dist is pinned to 5.5.207 in package.json, deliberately BELOW the
 * vulnerable range in GHSA-hq66-cqwq-w95j (arbitrary JS execution on a
 * malicious PDF, fixed >=6.2.108) rather than upgraded past it, because 6.x
 * requires Node >=22.13 and this project runs on Node 20.
 *
 * Layout fidelity (resume PR A, docs/resume-intelligence-design.md §1/§4):
 * the previous version joined every text item of a page with a space, so a
 * page came out as ONE line — section headings, bullets and paragraphs were
 * indistinguishable. Text is now laid out from the items' positions:
 *   - items on the same baseline form a line (left to right); a line break
 *     separates lines, a blank line separates paragraphs (large vertical gap);
 *   - a clear vertical gutter (two-column layout) is read column by column,
 *     with full-width lines (e.g. the name header) kept in place — and
 *     reported as a warning, because reordering is a heuristic;
 *   - private-use bullet glyphs (Symbol/Wingdings fonts) become "•".
 * Unreliable results fail with a clear message rather than being handed on
 * as if they were good text: no text (scanned), or mostly undecodable glyphs
 * (a broken font encoding). Softer problems are returned as `warnings` for
 * the UI to show next to the editable text.
 */

export class PdfTextExtractionError extends Error {}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
/** Below this many characters the text is kept but flagged: too little to review a resume from. */
export const MIN_USEFUL_CHARS = 200;
/** Share of undecodable glyphs (U+FFFD / private-use, bullets excluded) above which extraction is refused. */
export const MAX_UNDECODABLE_RATIO = 0.1;
/** …and above which it is kept with a warning. */
export const WARN_UNDECODABLE_RATIO = 0.02;

export type ExtractionWarningCode =
  | 'columns_reordered'
  | 'pages_truncated'
  | 'very_little_text'
  | 'some_characters_unreadable';

export interface ExtractionWarning {
  code: ExtractionWarningCode;
  message: string;
  /** 1-based page numbers, when the warning is page-specific. */
  pages?: number[];
}

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  pagesRead: number;
  warnings: ExtractionWarning[];
}

/** The subset of a pdfjs TextItem this module reads. Items without `str` (marked-content markers) are ignored. */
interface TextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  hasEOL?: unknown;
}

interface Glyph { str: string; x: number; y: number; w: number; fs: number }
interface Line { y: number; fs: number; glyphs: Glyph[] }

export interface PageLayout {
  text: string;
  lineCount: number;
  columnsReordered: boolean;
}

// Common private-use code points that Symbol/Wingdings-encoded bullets decode to.
const PUA_BULLETS = /[]/g;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const isItem = (v: unknown): v is TextItemLike => typeof v === 'object' && v !== null;

function toGlyph(item: unknown): Glyph | null {
  if (!isItem(item) || typeof item.str !== 'string') return null;
  const str = item.str.replace(PUA_BULLETS, '•');
  if (!str.trim()) return null;
  const t = Array.isArray(item.transform) ? item.transform : null;
  const x = t ? num(t[4]) : null;
  const y = t ? num(t[5]) : null;
  if (x === null || y === null) return null;
  const scale = Math.max(Math.abs(num(t![3]) ?? 0), Math.abs(num(t![0]) ?? 0));
  const fs = Math.max(scale, num(item.height) ?? 0, 1);
  return { str, x, y, w: Math.max(num(item.width) ?? 0, 0), fs };
}

/** Items without positions (not produced by pdfjs, but keep a sane answer): stream order, `hasEOL` → line break. */
function joinWithoutGeometry(items: ReadonlyArray<TextItemLike>): string {
  let out = '';
  for (const item of items) {
    if (!isItem(item) || typeof item.str !== 'string') continue;
    out += item.str.replace(PUA_BULLETS, '•');
    out += item.hasEOL === true ? '\n' : ' ';
  }
  return out;
}

function groupLines(glyphs: Glyph[]): Line[] {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const g of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - g.y) <= 0.45 * Math.min(last.fs, g.fs)) {
      last.glyphs.push(g);
      last.fs = Math.max(last.fs, g.fs);
    } else {
      lines.push({ y: g.y, fs: g.fs, glyphs: [g] });
    }
  }
  for (const l of lines) l.glyphs.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(glyphs: Glyph[]): string {
  let out = '';
  let prev: Glyph | null = null;
  for (const g of glyphs) {
    if (prev) {
      // Without a width we cannot measure the gap: fall back to a space (the old behaviour).
      const gap = prev.w > 0 ? g.x - (prev.x + prev.w) : Infinity;
      const touching = gap <= 0.15 * Math.min(prev.fs, g.fs);
      if (!touching && !/\s$/.test(out) && !/^\s/.test(g.str)) out += ' ';
    }
    out += g.str;
    prev = g;
  }
  return out.replace(/[ \t ]+/g, ' ').trim();
}

const crosses = (g: Glyph, c: number) => g.x < c && g.x + Math.max(g.w, g.fs * 0.5) > c;

// A year, "Present"/"Current" or a month name: the shape of a one-column resume's date (or "City | 2019") column.
const DATE_LIKE = /\b(19|20)\d{2}\b|\b(present|current|now)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i;

/**
 * A vertical gutter = an x position that (almost) no line's text crosses, with substantial text on BOTH sides.
 * Not a gutter: a side made mostly of dates. A one-column resume with right-aligned dates (or a left-hand date column)
 * has that shape, and splitting it would separate every date from its role. When body lines cross the middle the
 * crossing test already rules it out; the date test covers compact resumes whose lines are all short.
 */
function findGutter(lines: Line[]): number | null {
  if (lines.length < 8) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const l of lines) for (const g of l.glyphs) { minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x + g.w); }
  const width = maxX - minX;
  if (!(width > 0)) return null;
  const totalChars = lines.reduce((n, l) => n + l.glyphs.reduce((m, g) => m + g.str.length, 0), 0);

  let best: { c: number; crossing: number } | null = null;
  for (let f = 0.25; f <= 0.75; f += 0.01) {
    const c = minX + width * f;
    let crossing = 0;
    let leftLines = 0;
    let rightLines = 0;
    let leftChars = 0;
    let rightChars = 0;
    let leftDates = 0;
    let rightDates = 0;
    for (const l of lines) {
      if (l.glyphs.some((g) => crosses(g, c))) { crossing++; continue; }
      let left = '';
      let right = '';
      for (const g of l.glyphs) {
        if (g.x + g.w <= c) { left += ` ${g.str}`; leftChars += g.str.length; } else { right += ` ${g.str}`; rightChars += g.str.length; }
      }
      if (left.trim()) { leftLines++; if (DATE_LIKE.test(left)) leftDates++; }
      if (right.trim()) { rightLines++; if (DATE_LIKE.test(right)) rightDates++; }
    }
    const ok = crossing <= 0.15 * lines.length
      && leftLines >= 4 && rightLines >= 4
      && leftChars >= 0.15 * totalChars && rightChars >= 0.15 * totalChars
      && leftDates < 0.5 * leftLines && rightDates < 0.5 * rightLines;
    if (ok && (!best || crossing < best.crossing)) best = { c, crossing };
  }
  return best ? best.c : null;
}

function emitLines(lines: Line[], out: string[]) {
  if (lines.length === 0) return;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const typical = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
  lines.forEach((l, i) => {
    const text = lineText(l.glyphs);
    if (!text) return;
    if (i > 0 && out.length > 0) {
      const gap = gaps[i - 1];
      const paragraph = gap > Math.max(typical * 1.6, l.fs * 1.9);
      out.push(paragraph ? '\n\n' : '\n');
    }
    out.push(text);
  });
}

/** One page's text items → laid-out text (lines, paragraphs, column order). Pure. */
export function layoutPageItems(items: ReadonlyArray<unknown>): PageLayout {
  const list = (Array.isArray(items) ? items : []) as ReadonlyArray<TextItemLike>;
  const glyphs = list.map(toGlyph).filter((g): g is Glyph => g !== null);
  const textual = list.filter((i) => isItem(i) && typeof i.str === 'string' && i.str.trim());
  if (glyphs.length === 0 || glyphs.length < textual.length * 0.5) {
    const text = joinWithoutGeometry(list);
    return { text, lineCount: text.split('\n').filter((s) => s.trim()).length, columnsReordered: false };
  }

  const lines = groupLines(glyphs);
  const gutter = findGutter(lines);
  const parts: string[] = [];
  if (gutter === null) {
    emitLines(lines, parts);
  } else {
    // Reading order: full-width lines stay where they are; between them, the left column, then the right column.
    let left: Line[] = [];
    let right: Line[] = [];
    const flush = () => {
      for (const block of [left, right]) {
        if (block.length === 0) continue;
        if (parts.length) parts.push('\n\n');
        emitLines(block, parts);
      }
      left = [];
      right = [];
    };
    for (const l of lines) {
      if (l.glyphs.some((g) => crosses(g, gutter))) {
        flush();
        if (parts.length) parts.push('\n\n');
        emitLines([l], parts);
        continue;
      }
      const lg = l.glyphs.filter((g) => g.x + g.w <= gutter);
      const rg = l.glyphs.filter((g) => g.x + g.w > gutter);
      if (lg.length) left.push({ ...l, glyphs: lg });
      if (rg.length) right.push({ ...l, glyphs: rg });
    }
    flush();
  }
  const text = parts.join('');
  return { text, lineCount: lines.length, columnsReordered: gutter !== null };
}

/** One page's text items → text. Kept as the module's public per-page entry point. */
export function joinPageItems(items: ReadonlyArray<unknown>): string {
  return layoutPageItems(items).text;
}

/**
 * All pages → the final text: pages separated by a blank line; within a line, runs of spaces/tabs collapse to one
 * space; trailing spaces are trimmed; more than one blank line collapses to one; the whole text is trimmed.
 */
export function assemblePdfText(pageTexts: ReadonlyArray<string>): string {
  return pageTexts
    .join('\n\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Share of non-space characters that could not be decoded (U+FFFD or private use). Bullets were already mapped. */
export function undecodableRatio(text: string): number {
  const visible = text.replace(/\s+/g, '');
  if (!visible) return 0;
  const bad = visible.match(/[�-]/g)?.length ?? 0;
  return bad / visible.length;
}

/**
 * Pages → result or a clear error. Pure (no pdfjs), so the decision rules are testable without a browser.
 * `pageCount` is the document's real page count; `pages` are the pages that were read (at most MAX_PDF_PAGES).
 */
export function finalizeExtraction(pages: ReadonlyArray<PageLayout>, pageCount: number): PdfExtractionResult {
  const text = assemblePdfText(pages.map((p) => p.text));
  if (!text) {
    throw new PdfTextExtractionError(
      'No text found in this PDF — it may be a scanned image rather than real text. You can edit the box below manually instead.',
    );
  }
  const ratio = undecodableRatio(text);
  if (ratio > MAX_UNDECODABLE_RATIO) {
    throw new PdfTextExtractionError(
      "This PDF's text could not be read reliably (its fonts don't map to readable characters). Please paste your resume text into the box below instead, or export the PDF again from your editor.",
    );
  }
  const warnings: ExtractionWarning[] = [];
  const reordered = pages.map((p, i) => (p.columnsReordered ? i + 1 : 0)).filter(Boolean);
  if (reordered.length) {
    warnings.push({
      code: 'columns_reordered',
      message: 'This looks like a multi-column layout. We read it column by column — please check the order of the text below.',
      pages: reordered,
    });
  }
  if (pageCount > pages.length) {
    warnings.push({
      code: 'pages_truncated',
      message: `Only the first ${pages.length} of ${pageCount} pages were read.`,
    });
  }
  if (ratio > WARN_UNDECODABLE_RATIO) {
    warnings.push({
      code: 'some_characters_unreadable',
      message: 'Some characters in this PDF could not be read. Please check the text below and fix anything that looks wrong.',
    });
  }
  if (text.length < MIN_USEFUL_CHARS) {
    warnings.push({
      code: 'very_little_text',
      message: 'Very little text was found in this PDF. If your resume is longer, part of it may be an image — you can add the rest below.',
    });
  }
  return { text, pageCount, pagesRead: pages.length, warnings };
}

/** The pdfjs surface this module needs — the real library in the browser, the legacy build in tests. */
export interface PdfjsLike {
  getDocument(src: { data: Uint8Array | ArrayBuffer; standardFontDataUrl: string; [k: string]: unknown }): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>;
  };
}

/** Bytes → result, with any pdfjs implementation. Exported for tests; the app calls extractPdfText(file). */
export async function extractPdfTextFromData(
  pdfjs: PdfjsLike,
  data: Uint8Array | ArrayBuffer,
  options: { standardFontDataUrl: string; [k: string]: unknown },
): Promise<PdfExtractionResult> {
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PdfTextExtractionError('This PDF is larger than 10 MB. Please upload a smaller file or paste your resume text below.');
  }
  let doc;
  try {
    doc = await pdfjs.getDocument({ ...options, data }).promise;
  } catch {
    throw new PdfTextExtractionError(
      'Could not read this PDF — it may be corrupted or password-protected.',
    );
  }

  const pagesToRead = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages: PageLayout[] = [];
  try {
    for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      pages.push(layoutPageItems(content.items));
    }
  } catch {
    throw new PdfTextExtractionError('Could not read every page of this PDF — it may be damaged. Please paste your resume text below instead.');
  }
  return finalizeExtraction(pages, doc.numPages);
}

let workerConfigured = false;

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    workerConfigured = true;
  }
  return pdfjs;
}

export async function extractPdfText(file: File): Promise<PdfExtractionResult> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new PdfTextExtractionError('Please upload a PDF file.');
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new PdfTextExtractionError('This PDF is larger than 10 MB. Please upload a smaller file or paste your resume text below.');
  }

  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  return extractPdfTextFromData(pdfjs as unknown as PdfjsLike, buffer, { standardFontDataUrl: '/standard_fonts/' });
}
