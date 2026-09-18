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
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    pageTexts.push(text);
  }

  const fullText = pageTexts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  if (!fullText) {
    throw new PdfTextExtractionError(
      'No text found in this PDF — it may be a scanned image rather than real text. You can edit the box below manually instead.',
    );
  }
  return fullText;
}
