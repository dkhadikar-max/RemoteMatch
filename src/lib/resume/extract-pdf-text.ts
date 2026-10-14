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
 */

export class PdfTextExtractionError extends Error {}

/**
 * The text items of ONE page -> one string. Behaviour-identical extraction of the expression that used to be inline in
 * extractPdfText: items without `str` (e.g. marked-content markers) contribute "", and items are joined with a single
 * space, so the PDF's own line-end information is NOT used — a known limitation, deliberately unchanged here.
 */
export function joinPageItems(items: ReadonlyArray<unknown>): string {
  return items.map((item) => ('str' in (item as object) ? (item as { str: string }).str : '')).join(' ');
}

/** All pages -> the final text: pages separated by a blank line, runs of spaces/tabs collapsed, trimmed. Identical to the former inline expression. */
export function assemblePdfText(pageTexts: ReadonlyArray<string>): string {
  return pageTexts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
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

export async function extractPdfText(file: File): Promise<string> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new PdfTextExtractionError('Please upload a PDF file.');
  }

  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();

  let doc;
  try {
    doc = await pdfjs.getDocument({ data: buffer, standardFontDataUrl: '/standard_fonts/' }).promise;
  } catch {
    throw new PdfTextExtractionError(
      'Could not read this PDF — it may be corrupted or password-protected.',
    );
  }

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(joinPageItems(content.items));
  }

  const fullText = assemblePdfText(pageTexts);
  if (!fullText) {
    throw new PdfTextExtractionError(
      'No text found in this PDF — it may be a scanned image rather than real text. You can edit the box below manually instead.',
    );
  }
  return fullText;
}
