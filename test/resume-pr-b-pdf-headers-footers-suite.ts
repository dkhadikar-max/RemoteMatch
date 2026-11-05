/**
 * Resume Intelligence (PR B) — §9 offline PDF-extraction coverage, ONE genuinely new case.
 *
 * design doc §9 lists 8 PDF-extraction categories: "single/two-column, table, headers/footers,
 * 10 pages, scanned, password-protected" (before/after the PR A line-break fix). The pre-existing
 * `test/pdf-extraction-fidelity-suite.ts` (Resume PR A, 42/0, re-run unchanged as part of this
 * step) already covers: single-column, two-column (+8 edge cases including a two-up skills
 * "table"), 10+ pages (the MAX_PDF_PAGES cap test), scanned (blank-page -> "No text found"), and
 * password-protected (see this file's own note below — confirmed by reading the code, not a new
 * test, since it is the SAME generic catch-all path already exercised by the "corrupt" case).
 *
 * The one category that suite does not actually exercise is a REPEATED header/footer line across
 * multiple pages — a common real-PDF artifact (page numbers, a running "Jane Doe — Resume" line on
 * every page). This file adds that one case, offline, using the same local-PDF-builder technique
 * as the PR A suite (duplicated here deliberately rather than importing a private helper from
 * another test file).
 *
 * Password-protected note (not re-tested here, by design): extractPdfTextFromData's only error
 * path for ANY `pdfjs.getDocument()` rejection — whether from a malformed PDF or a real
 * PasswordException on an encrypted PDF with no password — is the single generic catch at
 * src/lib/resume/extract-pdf-text.ts:357-361, which always throws the same
 * "corrupted or password-protected" PdfTextExtractionError regardless of cause. The PR A suite's
 * existing "corrupt" case (garbage bytes) already proves that exact catch block produces the
 * correct user-facing message; a real encrypted PDF would hit the identical lines, confirmed by
 * reading the code, not assumption. Building a second PDF to exercise the same code path would
 * not test anything the existing case doesn't already prove.
 *
 * Run: npx tsx test/resume-pr-b-pdf-headers-footers-suite.ts
 */
import * as path from 'path';
import { extractPdfTextFromData, type PdfjsLike, type PdfExtractionResult } from '../src/lib/resume/extract-pdf-text';
import { extractionSignals } from '../src/lib/resume/rubric';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

type Run = { x: number; y: number; text: string; size?: number };
function buildPdf(pages: Run[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
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
async function extract(buf: Buffer): Promise<PdfExtractionResult> {
  return extractPdfTextFromData(pdfjs, new Uint8Array(buf), { standardFontDataUrl: STD_FONTS, useSystemFonts: false, isEvalSupported: false });
}

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME PR B — §9 PDF EXTRACTION: repeated header/footer across pages');
  console.log('='.repeat(78));
  pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;

  // A 3-page resume where every page repeats the same header line ("Jane Doe - Resume") and
  // footer line ("Page X of 3") — the common real-world PDF artifact this category targets.
  // (Plain hyphen, not an em-dash: WinAnsiEncoding byte-mapping for non-ASCII punctuation is out
  // of scope for this minimal test PDF builder — immaterial to what this case is testing.)
  const pages: Run[][] = [];
  for (let p = 1; p <= 3; p++) {
    pages.push([
      { x: 72, y: 760, text: 'Jane Doe - Resume', size: 10 },
      { x: 72, y: 700, text: `Section ${p} content line one describing real work for this page.` },
      { x: 72, y: 686, text: `Section ${p} content line two with more detail about the role.` },
      { x: 72, y: 40, text: `Page ${p} of 3`, size: 9 },
    ]);
  }
  const result = await extract(buildPdf(pages));

  assert(result.pageCount === 3 && result.pagesRead === 3, 'all 3 pages are read', JSON.stringify({ pageCount: result.pageCount, pagesRead: result.pagesRead }));
  const lines = result.text.split('\n');
  const headerCount = lines.filter((l) => l === 'Jane Doe - Resume').length;
  const footerLines = lines.filter((l) => /^Page \d of 3$/.test(l));
  assert(headerCount === 3, 'the repeated header line is preserved once per page (not deduped away, not merged into surrounding text)', JSON.stringify({ headerCount, lines }));
  assert(footerLines.length === 3 && new Set(footerLines).size === 3, 'the per-page footer lines are each preserved distinctly (not collapsed into one)', JSON.stringify(footerLines));
  assert(lines.includes('Section 1 content line one describing real work for this page.') && lines.includes('Section 3 content line two with more detail about the role.'), 'real per-page content survives alongside the repeated header/footer', JSON.stringify(lines));

  // The DOWNSTREAM consumer (rubric.ts's extractionSignals — already covered by
  // resume-intelligence-rubric-suite.ts) is what actually FLAGS a repeated header/footer line as
  // a `repeated_line` signal for the user — confirming the PDF layer's output feeds that detector
  // correctly end-to-end, not just that the PDF layer itself didn't crash.
  const signals = extractionSignals(result.text);
  assert(signals.some((s) => s.code === 'repeated_line'), 'the extracted text correctly triggers the repeated-header/footer-line signal downstream', JSON.stringify(signals));

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
