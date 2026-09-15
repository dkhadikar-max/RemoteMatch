/**
 * LinkedIn Job Finder — heuristic single-paste parser (plan §26 option (b)).
 *
 * Non-AI, best-effort, styled after analyzeResumeHeuristically's fallback
 * shape (src/lib/ai/resume-intelligence.ts): regex/keyword-over-raw-text,
 * never a network call, never invents a field it can't find. The UI always
 * shows the result as an editable confirm/edit step (plan §26 option (c))
 * — this function's job is to save typing, not to be authoritative.
 */

export interface ParsedPostingFields {
  title: string;
  company: string;
  description: string;
  location?: string;
}

const TITLE_LINE_MAX_LEN = 120;
const COMPANY_HINT_RE = /^(?:at|@)\s+(.+)$/i;
/** LinkedIn's own copy-paste output commonly includes a line shaped like
 *  "Title\nCompany Name\nLocation" or "Title at Company · Location" near
 *  the top of the pasted text — this pattern, not full-text NLP, is what
 *  the heuristic below targets. */
const TITLE_AT_COMPANY_RE = /^(.{1,120}?)\s+(?:at|@)\s+(.{1,120}?)(?:\s*[·|]\s*(.+))?$/i;

export function parsePastedPosting(rawText: string): ParsedPostingFields {
  const text = rawText.replace(/\r\n/g, '\n').trim();
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let title = '';
  let company = '';
  let location: string | undefined;

  // Pass 1: a single "Title at Company · Location" line, LinkedIn's most
  // common copy-paste shape for the posting header.
  for (const line of lines.slice(0, 5)) {
    const m = line.match(TITLE_AT_COMPANY_RE);
    if (m && m[1].length < TITLE_LINE_MAX_LEN) {
      title = m[1].trim();
      company = m[2].trim();
      if (m[3]) location = m[3].trim();
      break;
    }
  }

  // Pass 2: separate lines — first short line is the title, the next
  // short line (optionally "at Company") is the company.
  if (!title && lines.length > 0) {
    const first = lines[0];
    if (first.length < TITLE_LINE_MAX_LEN) title = first;
  }
  if (!company && lines.length > 1) {
    const second = lines[1];
    const hinted = second.match(COMPANY_HINT_RE);
    if (hinted) {
      company = hinted[1].trim();
    } else if (second.length < TITLE_LINE_MAX_LEN && !/^(remote|full-time|part-time|contract)/i.test(second)) {
      company = second;
    }
  }

  // Location: look for an explicit "Location:" label, or a short line
  // containing a comma (city, region) or "Remote"/"Worldwide" near the top.
  if (!location) {
    const locLabeled = text.match(/location:\s*(.+)/i);
    if (locLabeled) {
      location = locLabeled[1].split('\n')[0].trim();
    } else {
      const candidate = lines.slice(0, 6).find(
        (l) => l.length < 80 && (/remote|worldwide|,\s*[A-Z]{2}\b|anywhere/i.test(l))
      );
      if (candidate) location = candidate;
    }
  }

  // Description: the whole pasted text is the safest fallback — never
  // trims content the user explicitly gave us. If a clear "About the job"/
  // "Job description" marker exists, start from there instead, since
  // everything before it is usually just the header already captured above.
  const descMarker = text.match(/(about the job|job description|the role|about this role)[:\s]*\n/i);
  const description = descMarker
    ? text.slice((descMarker.index ?? 0) + descMarker[0].length).trim()
    : text;

  return {
    title: title || '',
    company: company || '',
    description: description || text,
    location,
  };
}
