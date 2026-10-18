/**
 * RemoteMatch — Resume PR A: PDF extraction fidelity suite
 * ==============================================================================
 * The previous extractor joined every text item of a page with a space, so each page came out as one line. This suite
 * proves the layout-aware replacement on REAL pdfjs output (pdfjs-dist legacy build, the same pinned 5.5.207) from
 * hand-built PDFs — no libraries, no network, no database — plus pure-function cases for the decision rules:
 *
 *   1. one-column resume: lines, bullets and paragraph breaks are preserved; split words are not broken apart
 *   2. right-aligned dates stay on their line (a one-column resume is NOT mistaken for two columns)
 *   3. two-column layout is read column by column, header kept first, and reported as a warning; 3b: eight layout
 *      edge cases (compact one-column with right-aligned or left-hand dates, skills grid, centred header, sidebars)
 *   4. limits and failures: page cap (warning), blank/scanned page, corrupted, truncated and oversized files fail
 *      with a PdfTextExtractionError carrying a user-facing message — never a raw exception, never silent text
 *   5. pure rules: private-use bullets, undecodable-glyph thresholds, very-little-text warning, items without
 *      positions, hostile item lists (fuzz) never throw
 *   6. the facts-only resume check still works on multi-line text
 *
 * Run: npx tsx test/pdf-extraction-fidelity-suite.ts
 */
import * as path from 'path';
import {
  layoutPageItems,
  assemblePdfText,
  finalizeExtraction,
  extractPdfTextFromData,
  undecodableRatio,
  PdfTextExtractionError,
  MAX_PDF_PAGES,
  MAX_PDF_BYTES,
  type PdfjsLike,
  type PdfExtractionResult,
} from '../src/lib/resume/extract-pdf-text';
import { checkResumeAgainstSkills } from '../src/lib/resume/resume-check';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── a minimal PDF writer: absolutely positioned Helvetica text runs, any number of pages ──
type Run = { x: number; y: number; text: string; size?: number };
function buildPdf(pages: Run[][]): Buffer {
  // WinAnsiEncoding: the bullet is byte 0x95; everything else used here is Latin-1.
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&').replace(/•/g, '\x95');
  const objs: string[] = [];
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const fontId = 3;
  objs[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const kids: number[] = [];
  pages.forEach((runs) => {
    const content = runs.map((r) => `BT /F1 ${r.size ?? 11} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${esc(r.text)}) Tj ET`).join('\n');
    const contentId = objs.length + 1;
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageId = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    kids.push(pageId);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const root = path.join(__dirname, '..');
const STD_FONTS = path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts').split(path.sep).join('/') + '/';
let pdfjs: PdfjsLike;
async function extract(buf: Buffer | Uint8Array): Promise<PdfExtractionResult> {
  return extractPdfTextFromData(pdfjs, new Uint8Array(buf), { standardFontDataUrl: STD_FONTS, useSystemFonts: false, isEvalSupported: false });
}
async function extractError(buf: Buffer | Uint8Array): Promise<unknown> {
  try { await extract(buf); return null; } catch (e) { return e; }
}

// Helvetica advance widths (per 1000 em) for the few strings positioned edge to edge below.
const HELV: Record<string, number> = { E: 667, n: 556, g: 556 };
const width = (s: string, size: number) => s.split('').reduce((w, c) => w + (HELV[c] ?? 556), 0) * size / 1000;

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME PR A — PDF EXTRACTION FIDELITY');
  console.log('='.repeat(78));
  pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;

  console.log('\n1. One-column resume keeps lines, bullets and paragraphs');
  const oneCol: Run[] = [
    { x: 72, y: 740, text: 'Jane Doe', size: 18 },
    { x: 72, y: 718, text: 'Content Writer | Remote' },
    { x: 72, y: 680, text: 'EXPERIENCE', size: 12 },
    { x: 72, y: 662, text: 'Senior Writer, Northwind Media' },
    { x: 80, y: 648, text: '• Wrote 4 long-form articles per week on B2B software' },
    { x: 80, y: 634, text: '• Managed social media for three product lines' },
    { x: 72, y: 596, text: 'EDUCATION', size: 12 },
    { x: 72, y: 578, text: 'BA English, State University' },
  ];
  // "Eng" + "ineer" placed edge to edge: one word in the PDF, must not gain a space.
  const engW = width('Eng', 11);
  oneCol.push({ x: 72, y: 560, text: 'Eng' }, { x: 72 + engW, y: 560, text: 'ineer' });
  const r1 = await extract(buildPdf([oneCol]));
  const lines1 = r1.text.split('\n');
  assert(lines1[0] === 'Jane Doe' && lines1[1] === 'Content Writer | Remote', 'header lines are separate lines', JSON.stringify(lines1.slice(0, 3)));
  assert(lines1.includes('• Wrote 4 long-form articles per week on B2B software') && lines1.includes('• Managed social media for three product lines'), 'each bullet is its own line, glyph kept', JSON.stringify(lines1));
  assert(/Remote\n\nEXPERIENCE/.test(r1.text) && /product lines\n\nEDUCATION/.test(r1.text), 'large vertical gaps become paragraph breaks before section headings', JSON.stringify(r1.text));
  assert(/Northwind Media\n• Wrote/.test(r1.text), 'normal line spacing is a single line break (no blank line inside a section)');
  assert(lines1.includes('Engineer'), 'a word split into two touching runs is NOT broken apart', JSON.stringify(lines1.slice(-2)));
  assert(r1.warnings.length === 0 && r1.pageCount === 1 && r1.pagesRead === 1, 'no warnings on a clean one-page, one-column resume', JSON.stringify(r1.warnings));
  const check = checkResumeAgainstSkills(['Social Media', 'Copywriting'], r1.text);
  assert(check.status === 'ok' && check.found.includes('Social Media') && check.notFound.includes('Copywriting'), 'the facts-only resume check works unchanged on multi-line text', JSON.stringify(check));

  console.log('\n2. Right-aligned dates stay on their line (not mistaken for columns)');
  const dated: Run[] = [];
  let y = 740;
  for (let i = 0; i < 5; i++) {
    dated.push({ x: 72, y, text: `Role ${i + 1}, Company ${i + 1}` }, { x: 470, y, text: `${2015 + i} - ${2016 + i}` });
    y -= 14;
    dated.push({ x: 80, y, text: `• Delivered a full-width bullet describing the work done in role number ${i + 1} here` });
    y -= 22;
  }
  const r2 = await extract(buildPdf([dated]));
  assert(r2.text.split('\n').includes('Role 1, Company 1 2015 - 2016'), 'title and its right-aligned date are one line', JSON.stringify(r2.text.split('\n').slice(0, 3)));
  assert(!r2.warnings.some((w) => w.code === 'columns_reordered'), 'no column reordering on a one-column resume with right-aligned dates', JSON.stringify(r2.warnings));
  assert(r2.text.indexOf('Role 2') < r2.text.indexOf('2017 - 2018') && r2.text.indexOf('2016 - 2017') < r2.text.indexOf('Role 3'), 'dates stay next to their own role (reading order intact)');

  console.log('\n3. Two-column layout is read column by column');
  const twoCol: Run[] = [{ x: 72, y: 750, text: 'Alex Kim - Product Designer - alex@example.invalid - Remote, Portugal', size: 12 }];
  const left = ['SKILLS', 'Figma', 'User research', 'Prototyping', 'Design systems', 'LANGUAGES', 'English', 'Portuguese'];
  const right = ['EXPERIENCE', 'Lead Product Designer, Contoso', 'Redesigned onboarding for a payments app', 'Ran weekly usability sessions with customers', 'Product Designer, Fabrikam', 'Built a component library used by four teams', 'Shipped the mobile checkout redesign', 'EDUCATION'];
  for (let i = 0; i < 8; i++) {
    twoCol.push({ x: 40, y: 700 - i * 16, text: left[i] }, { x: 250, y: 700 - i * 16, text: right[i] });
  }
  const r3 = await extract(buildPdf([twoCol]));
  const iHeader = r3.text.indexOf('Alex Kim');
  const iSkills = r3.text.indexOf('SKILLS');
  const iPortuguese = r3.text.indexOf('Portuguese');
  const iExperience = r3.text.indexOf('EXPERIENCE');
  assert(iHeader === 0, 'the full-width header comes first', JSON.stringify(r3.text.slice(0, 80)));
  assert(iSkills < iPortuguese && iPortuguese < iExperience, 'the whole left column precedes the right column', JSON.stringify(r3.text));
  assert(r3.text.split('\n').includes('Lead Product Designer, Contoso') && r3.text.split('\n').includes('Figma'), 'column lines are not merged across the gutter', JSON.stringify(r3.text.split('\n').slice(0, 6)));
  const w3 = r3.warnings.find((w) => w.code === 'columns_reordered');
  assert(!!w3 && JSON.stringify(w3.pages) === '[1]', 'reordering is reported as a warning naming the page', JSON.stringify(r3.warnings));

  console.log('\n3b. Column-detection edge cases (one-column layouts must NOT be split; real columns must be)');
  type Edge = { name: string; runs: Run[]; reorder: boolean; lines?: string[]; order?: string[] };
  const edges: Edge[] = [];
  {
    // A compact one-column resume: no body line crosses the middle, dates right-aligned.
    const r: Run[] = [{ x: 72, y: 750, text: 'Sam Lee', size: 16 }];
    let yy = 720;
    for (let i = 0; i < 6; i++) {
      r.push({ x: 72, y: yy, text: `Analyst, Firm ${i + 1}` }, { x: 480, y: yy, text: `${2014 + i} - ${2015 + i}` });
      yy -= 14; r.push({ x: 80, y: yy, text: '• Built monthly reports' }); yy -= 14;
      r.push({ x: 80, y: yy, text: '• Cut close time' }); yy -= 20;
    }
    edges.push({ name: 'compact one-column with right-aligned dates', runs: r, reorder: false, lines: ['Analyst, Firm 1 2014 - 2015', 'Analyst, Firm 6 2019 - 2020'] });
  }
  {
    const r: Run[] = [{ x: 72, y: 750, text: 'Priya Nair - Operations Manager', size: 14 }];
    let yy = 720;
    for (let i = 0; i < 5; i++) {
      r.push({ x: 72, y: yy, text: `Operations Lead, Company ${i + 1}` }, { x: 430, y: yy, text: `Pune, India | ${2016 + i}` });
      yy -= 14; r.push({ x: 80, y: yy, text: '• Coordinated vendor schedules for regional warehouses' }); yy -= 22;
    }
    edges.push({ name: 'one-column with right-aligned "City | year"', runs: r, reorder: false, lines: ['Operations Lead, Company 1 Pune, India | 2016'] });
  }
  {
    // Dates in a LEFT-hand column, content to the right (a common one-column style).
    const r: Run[] = [{ x: 72, y: 750, text: 'Dana Ortiz', size: 16 }];
    let yy = 720;
    for (let i = 0; i < 6; i++) {
      r.push({ x: 72, y: yy, text: `Jan ${2014 + i} - Dec ${2014 + i}` }, { x: 200, y: yy, text: `Bookkeeper, Office ${i + 1}` });
      yy -= 14; r.push({ x: 200, y: yy, text: '• Reconciled accounts' }); yy -= 20;
    }
    edges.push({ name: 'left-hand date column', runs: r, reorder: false, lines: ['Jan 2014 - Dec 2014 Bookkeeper, Office 1'] });
  }
  {
    // Right-aligned text WITHOUT dates (locations), full-width bullets: only the "lines cross the middle" rule keeps it
    // one column — the date guard cannot help here.
    const r: Run[] = [{ x: 72, y: 750, text: 'Ali Hassan - Customer Success', size: 14 }];
    let yy = 720;
    for (let i = 0; i < 5; i++) {
      r.push({ x: 72, y: yy, text: `Customer Success Manager, Company ${i + 1}` }, { x: 420, y: yy, text: 'London, United Kingdom' });
      yy -= 14; r.push({ x: 80, y: yy, text: `• Managed a portfolio of enterprise accounts and led quarterly business reviews ${i + 1}` }); yy -= 22;
    }
    edges.push({ name: 'one-column with right-aligned locations (no dates) and full-width bullets', runs: r, reorder: false, lines: ['Customer Success Manager, Company 1 London, United Kingdom'] });
  }
  {
    const r: Run[] = [{ x: 72, y: 750, text: 'Summary', size: 12 }, { x: 72, y: 734, text: 'Customer support specialist with experience across email, chat and phone channels for SaaS.' }, { x: 72, y: 700, text: 'Skills', size: 12 }];
    [['Zendesk', 'Intercom'], ['Ticket triage', 'Refund handling'], ['Knowledge base', 'Macros'], ['Escalations', 'CSAT reporting']]
      .forEach(([a, b], i) => r.push({ x: 72, y: 684 - i * 14, text: a }, { x: 320, y: 684 - i * 14, text: b }));
    r.push({ x: 72, y: 610, text: 'Experience', size: 12 });
    for (let i = 0; i < 4; i++) r.push({ x: 80, y: 594 - i * 14, text: `• Resolved customer issues across channels while maintaining service levels ${i + 1}` });
    edges.push({ name: 'one-column with a two-up skills grid', runs: r, reorder: false, lines: ['Zendesk Intercom'] });
  }
  {
    const r: Run[] = [{ x: 230, y: 760, text: 'Chris Park', size: 18 }, { x: 72, y: 740, text: 'Video Editor' }, { x: 400, y: 740, text: 'chris@example.invalid' }];
    for (let i = 0; i < 8; i++) r.push({ x: 72, y: 710 - i * 14, text: `• Edited weekly long-form videos and short clips for brand channels, number ${i + 1}` });
    edges.push({ name: 'centred header + right-aligned contact', runs: r, reorder: false, order: ['Chris Park', 'Video Editor chris@example.invalid', 'number 1', 'number 8'] });
  }
  {
    const r: Run[] = [{ x: 72, y: 750, text: 'Morgan Diaz - Financial Analyst - morgan@example.invalid - Remote', size: 12 }];
    const main = ['EXPERIENCE', 'Senior Financial Analyst, Globex', 'Built the quarterly forecast model', 'Partnered with sales on pricing', 'Financial Analyst, Initech', 'Automated variance reporting', 'Supported annual budgeting', 'EDUCATION'];
    const side = ['SKILLS', 'Excel', 'SQL', 'Forecasting', 'Power BI', 'CERTS', 'CFA Level I', 'FMVA'];
    for (let i = 0; i < 8; i++) r.push({ x: 60, y: 700 - i * 16, text: main[i] }, { x: 420, y: 700 - i * 16, text: side[i] });
    edges.push({ name: 'two-column with the sidebar on the right', runs: r, reorder: true, order: ['Morgan Diaz', 'EXPERIENCE', 'EDUCATION', 'SKILLS', 'FMVA'] });
  }
  {
    const r: Run[] = [{ x: 72, y: 760, text: 'Taylor Brooks - Recruiter - taylor@example.invalid - Remote, Canada', size: 12 }];
    const left = ['EXPERIENCE', 'Technical Recruiter, Umbrella', 'Sourced engineers for platform teams', 'Ran structured interview loops', 'Recruiter, Hooli', 'Managed agency relationships', 'Built a referral program', 'Coordinated onsite schedules', 'Recruiting Coordinator, Pied Piper', 'Scheduled panel interviews', 'Maintained the ATS records', 'EDUCATION'];
    const right = ['SKILLS', 'Greenhouse', 'LinkedIn Recruiter', 'Boolean search', 'Offer negotiation'];
    left.forEach((t, i) => r.push({ x: 60, y: 720 - i * 16, text: t }));
    right.forEach((t, i) => r.push({ x: 400, y: 720 - i * 16, text: t }));
    edges.push({ name: 'two-column, long main column + short sidebar', runs: r, reorder: true, order: ['Taylor Brooks', 'EXPERIENCE', 'EDUCATION', 'SKILLS', 'Offer negotiation'] });
  }
  for (const e of edges) {
    const res = await extract(buildPdf([e.runs]));
    const reordered = res.warnings.some((w) => w.code === 'columns_reordered');
    const ls = res.text.split('\n');
    const linesOk = (e.lines ?? []).every((l) => ls.includes(l));
    let orderOk = true;
    let last = -1;
    for (const o of e.order ?? []) { const i = res.text.indexOf(o); if (i <= last) { orderOk = false; break; } last = i; }
    assert(reordered === e.reorder && linesOk && orderOk, `${e.name}: ${e.reorder ? 'read column by column, with a warning' : 'kept as one column (no reorder, no warning)'}`, JSON.stringify({ reordered, linesOk, orderOk, text: res.text.slice(0, 160) }));
  }

  console.log('\n4. Limits and failures are explicit');
  const many = Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => [{ x: 72, y: 700, text: `Page ${i + 1} text with enough words to count as content for the resume reader here.` }]);
  const r4 = await extract(buildPdf(many));
  assert(r4.pageCount === MAX_PDF_PAGES + 2 && r4.pagesRead === MAX_PDF_PAGES, `only the first ${MAX_PDF_PAGES} pages are read`);
  assert(r4.warnings.some((w) => w.code === 'pages_truncated' && w.message.includes(`${MAX_PDF_PAGES} of ${MAX_PDF_PAGES + 2}`)), 'the page cap is reported, not silent', JSON.stringify(r4.warnings));
  assert(!r4.text.includes(`Page ${MAX_PDF_PAGES + 1} `), 'text beyond the cap is not included');

  const blank = await extractError(buildPdf([[]]));
  assert(blank instanceof PdfTextExtractionError && /No text found/.test((blank as Error).message), 'a page with no text (scanned image) fails with the "no text" message', String(blank));
  const corrupt = await extractError(Buffer.from('%PDF-1.4\nthis is not a pdf at all\n%%EOF', 'latin1'));
  assert(corrupt instanceof PdfTextExtractionError && /corrupted or password-protected/.test((corrupt as Error).message), 'garbage bytes fail with the corrupted/password message', String(corrupt));
  const notPdf = await extractError(Buffer.from('PK\u0003\u0004 a zip, not a pdf', 'latin1'));
  assert(notPdf instanceof PdfTextExtractionError, 'a non-PDF file fails with a PdfTextExtractionError', String(notPdf));
  const full = buildPdf([oneCol]);
  const truncated = await extractError(full.subarray(0, Math.floor(full.length * 0.6)));
  assert(truncated === null || truncated instanceof PdfTextExtractionError, 'a truncated PDF either recovers or fails with a user-facing PdfTextExtractionError (never a raw exception)', String(truncated));
  const big = await extractError(new Uint8Array(MAX_PDF_BYTES + 1));
  assert(big instanceof PdfTextExtractionError && /larger than 10 MB/.test((big as Error).message), 'a file over 10 MB is refused before parsing', String(big));
  const throwingPage: PdfjsLike = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.reject(new Error('boom')) }) }) };
  let pageErr: unknown = null;
  try { await extractPdfTextFromData(throwingPage, new Uint8Array(10), { standardFontDataUrl: '' }); } catch (e) { pageErr = e; }
  assert(pageErr instanceof PdfTextExtractionError && !/boom/.test((pageErr as Error).message), 'a page that fails to load gives a user-facing error that does not leak internals', String(pageErr));

  console.log('\n5. Pure decision rules');
  const item = (str: string, x: number, y: number, w = 0, size = 11) => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size });
  const pua = layoutPageItems([item('', 72, 700, 4), item('Led a team', 80, 700, 50)]);
  assert(pua.text === '• Led a team', 'Symbol/Wingdings private-use bullets become "•"', JSON.stringify(pua.text));
  const touching = layoutPageItems([item('Eng', 72, 700, 20), item('ineer', 92, 700, 25)]);
  const spaced = layoutPageItems([item('Senior', 72, 700, 30), item('Engineer', 106, 700, 40)]);
  assert(touching.text === 'Engineer' && spaced.text === 'Senior Engineer', 'runs that touch join without a space; runs with a gap get one', JSON.stringify([touching.text, spaced.text]));
  const okText = 'A'.repeat(300);
  const garbled = 'Résumé ' + ''.repeat(60) + ' ' + 'a'.repeat(300);
  assert(undecodableRatio(garbled) > 0.1, 'undecodable ratio counts private-use glyphs');
  let garbledErr: unknown = null;
  try { finalizeExtraction([{ text: garbled, lineCount: 1, columnsReordered: false }], 1); } catch (e) { garbledErr = e; }
  assert(garbledErr instanceof PdfTextExtractionError && /could not be read reliably/.test((garbledErr as Error).message), 'mostly undecodable text is REFUSED (not passed on as a resume)', String(garbledErr));
  const someBad = finalizeExtraction([{ text: '�'.repeat(10) + ' ' + okText, lineCount: 1, columnsReordered: false }], 1);
  assert(someBad.warnings.some((w) => w.code === 'some_characters_unreadable'), 'a few undecodable glyphs (2–10%) are kept with a warning', JSON.stringify(someBad.warnings));
  const short = finalizeExtraction([{ text: 'Jane Doe\nWriter', lineCount: 2, columnsReordered: false }], 1);
  assert(short.warnings.some((w) => w.code === 'very_little_text'), 'very little text is flagged', JSON.stringify(short.warnings));
  const noGeom = layoutPageItems([{ str: 'Line one', hasEOL: true }, { str: 'Line two', hasEOL: false }, { str: 'same line', hasEOL: true }]);
  assert(assemblePdfText([noGeom.text]) === 'Line one\nLine two same line', 'items without positions fall back to stream order with hasEOL line breaks', JSON.stringify(noGeom.text));
  assert(assemblePdfText(['a  \t b  ', '', '\n\n\n c']) === 'a b\n\nc', 'assembly collapses spaces/tabs, trims lines, keeps at most one blank line');
  assert(assemblePdfText([]) === '' && assemblePdfText(['  ', '\t']) === '', 'empty / whitespace-only pages assemble to ""');

  let rng = 1337;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const atoms: unknown[] = [null, 0, 'x', { str: 5 }, { str: 'a', transform: 'no' }, { str: 'b', transform: [1, 0, 0, 1, NaN, 3] }, { type: 'beginMarkedContent' }, { str: '•' }, { str: '' }];
  let fuzzOk = true;
  let fuzzDetail = '';
  for (let i = 0; i < 2000 && fuzzOk; i++) {
    const items = Array.from({ length: Math.floor(rnd() * 40) }, () => rnd() < 0.6
      ? item(['Senior', 'Engineer', '•', 'C++', '2020', 'résumé', ' '][Math.floor(rnd() * 7)], Math.floor(rnd() * 600), Math.floor(rnd() * 800), Math.floor(rnd() * 80), 6 + Math.floor(rnd() * 14))
      : atoms[Math.floor(rnd() * atoms.length)]);
    try { const r = layoutPageItems(items); if (typeof r.text !== 'string') { fuzzOk = false; fuzzDetail = 'non-string'; } }
    catch (e) { fuzzOk = false; fuzzDetail = (e as Error).message; }
  }
  assert(fuzzOk, 'layoutPageItems never throws on 2,000 random/hostile item lists', fuzzDetail);
  assert(layoutPageItems(null as unknown as unknown[]).text === '', 'a non-array page yields empty text');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
