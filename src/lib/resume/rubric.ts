/**
 * Resume Intelligence — the deterministic layer (migration 036, resume PR B).
 * docs/resume-intelligence-design.md §4. Pure; never throws; no network, no AI.
 *
 * Runs on every analysis request and is the whole output when the model is
 * unavailable, over quota, or the input is too thin — always labelled
 * "Automated checks" (source: 'rules'), visibly separate from anything AI.
 */
import { normalizeResumeText, skillAppearsInText } from './skill-evidence';

export const MIN_ANALYSIS_CHARS = 200;
export const MAX_ANALYSIS_CHARS = 30_000;

export interface ResumeSection {
  id: string;
  heading: string;
  headingMatched: string | null;
  start: number;
  end: number;
}

export interface ResumeBullet {
  id: string;
  sectionId: string | null;
  text: string;
  start: number;
  end: number;
  leadingVerb: string | null;
}

export interface ExtractionSignal {
  code: 'very_long_line' | 'no_line_breaks' | 'repeated_line' | 'non_letter_heavy';
  message: string;
}

export interface DateRange {
  raw: string;
  start: { year: number; month: number | null } | null;
  end: { year: number; month: number | null } | null; // null end = ongoing/"Present"
  start_: number;
  end_: number;
}

export interface ChronologyFinding {
  code: 'overlap' | 'gap';
  message: string;
  rangeIndexes: number[];
}

export interface DuplicateBullet {
  aId: string;
  bId: string;
  similarity: number;
}

export interface SkillSectionEvidence {
  skill: string;
  inExperienceOrProjects: boolean;
  inSkillsOnly: boolean;
  notFound: boolean;
}

export interface DeterministicResult {
  sections: ResumeSection[];
  bullets: ResumeBullet[];
  extractionSignals: ExtractionSignal[];
  dateRanges: DateRange[];
  chronologyFindings: ChronologyFinding[];
  duplicates: DuplicateBullet[];
  skillEvidence: SkillSectionEvidence[];
  wordCount: number;
  charCount: number;
}

// ── section map ───────────────────────────────────────────────────────────

const HEADING_LEXICON: Array<{ id: string; heading: string; pattern: RegExp }> = [
  { id: 'summary', heading: 'Summary', pattern: /^(summary|profile|about|objective)\b/i },
  { id: 'experience', heading: 'Experience', pattern: /^(experience|work experience|employment( history)?|professional experience)\b/i },
  { id: 'education', heading: 'Education', pattern: /^education\b/i },
  { id: 'skills', heading: 'Skills', pattern: /^(skills|technical skills|core competencies)\b/i },
  { id: 'projects', heading: 'Projects', pattern: /^projects?\b/i },
  { id: 'certifications', heading: 'Certifications', pattern: /^(certifications?|certificates?|licenses?)\b/i },
  { id: 'publications', heading: 'Publications', pattern: /^publications?\b/i },
  { id: 'volunteering', heading: 'Volunteering', pattern: /^(volunteer(ing)?|community)\b/i },
  { id: 'awards', heading: 'Awards', pattern: /^(awards?|honors?|achievements?)\b/i },
  { id: 'languages', heading: 'Languages', pattern: /^languages?\b/i },
  { id: 'interests', heading: 'Interests', pattern: /^(interests?|hobbies)\b/i },
  { id: 'references', heading: 'References', pattern: /^references?\b/i },
];

/** A line counts as a heading candidate: short, no terminal punctuation, matches the lexicon. */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (/[.!?,]$/.test(t)) return false;
  return HEADING_LEXICON.some((h) => h.pattern.test(t));
}

export function buildSectionMap(text: string): ResumeSection[] {
  const lines = text.split('\n');
  const sections: ResumeSection[] = [];
  let offset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const headingLineIdx: Array<{ lineIdx: number; id: string; heading: string; headingMatched: string }> = [];
  lines.forEach((line, i) => {
    if (!isHeadingLine(line)) return;
    const entry = HEADING_LEXICON.find((h) => h.pattern.test(line.trim()));
    if (entry) headingLineIdx.push({ lineIdx: i, id: entry.id, heading: entry.heading, headingMatched: line.trim() });
  });

  if (headingLineIdx.length === 0) {
    return [{ id: 'body', heading: 'Resume', headingMatched: null, start: 0, end: text.length }];
  }

  // Header block before the first recognised heading, if any non-trivial text precedes it.
  if (headingLineIdx[0].lineIdx > 0) {
    const headerEnd = lineOffsets[headingLineIdx[0].lineIdx];
    if (text.slice(0, headerEnd).trim().length > 0) {
      sections.push({ id: 'header', heading: 'Header', headingMatched: null, start: 0, end: headerEnd });
    }
  }

  headingLineIdx.forEach((h, i) => {
    const start = lineOffsets[h.lineIdx];
    const nextStart = i + 1 < headingLineIdx.length ? lineOffsets[headingLineIdx[i + 1].lineIdx] : text.length;
    // Avoid duplicate ids (e.g. "Experience" appearing twice) by suffixing.
    let id = h.id;
    let n = 2;
    while (sections.some((s) => s.id === id)) { id = `${h.id}-${n}`; n++; }
    sections.push({ id, heading: h.heading, headingMatched: h.headingMatched, start, end: nextStart });
  });

  return sections;
}

// ── bullets ──────────────────────────────────────────────────────────────

const BULLET_GLYPH = /^[\s]*[••●▪‣⁃*▪◦‣-]\s+/;
const LEADING_VERB = /^([A-Za-z]+)\b/;

export function extractBullets(text: string, sections: ResumeSection[]): ResumeBullet[] {
  const bullets: ResumeBullet[] = [];
  let offset = 0;
  const lines = text.split('\n');
  let n = 0;
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (BULLET_GLYPH.test(line)) {
      const body = line.replace(BULLET_GLYPH, '').trim();
      if (!body) continue;
      const section = sections.find((s) => start >= s.start && start < s.end);
      n++;
      const verbMatch = LEADING_VERB.exec(body);
      bullets.push({
        id: `b${n}`,
        sectionId: section?.id ?? null,
        text: body,
        start,
        end,
        leadingVerb: verbMatch ? verbMatch[1] : null,
      });
    }
  }
  return bullets;
}

// ── extraction-quality signals ───────────────────────────────────────────

export function extractionSignals(text: string): ExtractionSignal[] {
  const signals: ExtractionSignal[] = [];
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length <= 1 && text.length > 300) {
    signals.push({ code: 'no_line_breaks', message: 'This text has no line breaks — section and bullet structure may be lost.' });
  }
  const veryLong = lines.filter((l) => l.length > 300).length;
  if (veryLong > 0) {
    signals.push({ code: 'very_long_line', message: `${veryLong} line(s) are unusually long — columns or a table may have been merged together.` });
  }
  const freq = new Map<string, number>();
  for (const l of lines) { const t = l.trim(); if (t.length >= 8) freq.set(t, (freq.get(t) ?? 0) + 1); }
  const repeated = Array.from(freq.values()).filter((c) => c >= 3).length;
  if (repeated > 0) {
    signals.push({ code: 'repeated_line', message: 'A header or footer line repeats several times — it may have been extracted once per page.' });
  }
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const nonSpace = text.replace(/\s/g, '').length;
  if (nonSpace > 200 && letters / nonSpace < 0.5) {
    signals.push({ code: 'non_letter_heavy', message: 'Much of this text is not alphabetic — extraction may be unreliable.' });
  }
  return signals;
}

// ── chronology ───────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const DATE_RANGE_RE =
  /\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(\d{4})\s*(?:[-–—to]+|to)\s*(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(\d{4}|present|current|now)\b/gi;

export function extractDateRanges(text: string): DateRange[] {
  const ranges: DateRange[] = [];
  let m: RegExpExecArray | null;
  DATE_RANGE_RE.lastIndex = 0;
  while ((m = DATE_RANGE_RE.exec(text))) {
    const [raw, m1, y1, m2, y2raw] = m;
    const startYear = Number(y1);
    const ongoing = /present|current|now/i.test(y2raw);
    const endYear = ongoing ? null : Number(y2raw);
    if (startYear < 1950 || startYear > 2100) continue;
    if (endYear !== null && (endYear < 1950 || endYear > 2100)) continue;
    ranges.push({
      raw,
      start: { year: startYear, month: m1 ? MONTHS[m1.toLowerCase().slice(0, 3)] ?? null : null },
      end: ongoing ? null : { year: endYear as number, month: m2 ? MONTHS[m2.toLowerCase().slice(0, 3)] ?? null : null },
      start_: m.index,
      end_: m.index + raw.length,
    });
  }
  return ranges.sort((a, b) => a.start_ - b.start_);
}

function monthsSince(r: DateRange, field: 'start' | 'end'): number {
  const v = field === 'start' ? r.start : r.end;
  if (!v) return Infinity; // ongoing counts as "now" — always latest
  return v.year * 12 + (v.month ?? 6); // unknown month -> mid-year, a neutral guess
}

/**
 * Neutral observations only — never a judgment, per the design doc ("stated as neutral
 * observations"). Deliberately does NOT flag text order (e.g. "this range appears after one
 * that starts later"): the overwhelming majority of resumes list experience newest-first,
 * which is exactly that shape and is not a defect. Overlap/gap are computed by actual START
 * DATE, independent of where a range sits in the text, so they work correctly either way.
 */
export function findChronologyIssues(ranges: DateRange[]): ChronologyFinding[] {
  const findings: ChronologyFinding[] = [];
  if (ranges.length < 2) return findings;
  const byStart = ranges.map((r, i) => ({ r, i })).sort((a, b) => monthsSince(a.r, 'start') - monthsSince(b.r, 'start'));
  for (let k = 0; k < byStart.length - 1; k++) {
    const a = byStart[k];
    const b = byStart[k + 1];
    const aEnd = monthsSince(a.r, 'end');
    const bStart = monthsSince(b.r, 'start');
    if (aEnd !== Infinity && bStart < aEnd) {
      findings.push({ code: 'overlap', message: `${a.r.raw} and ${b.r.raw} overlap.`, rangeIndexes: [a.i, b.i] });
    } else if (aEnd !== Infinity && bStart - aEnd > 6) {
      findings.push({ code: 'gap', message: `A gap of more than 6 months appears between ${a.r.raw} and ${b.r.raw}.`, rangeIndexes: [a.i, b.i] });
    }
  }
  return findings;
}

// ── duplicates ───────────────────────────────────────────────────────────

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of Array.from(a)) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function findDuplicateBullets(bullets: ResumeBullet[]): DuplicateBullet[] {
  const out: DuplicateBullet[] = [];
  const sets = bullets.map((b) => tokenSet(b.text));
  for (let i = 0; i < bullets.length; i++) {
    for (let j = i + 1; j < bullets.length; j++) {
      const sim = jaccard(sets[i], sets[j]);
      if (sim >= 0.85) out.push({ aId: bullets[i].id, bId: bullets[j].id, similarity: sim });
    }
  }
  return out;
}

// ── skills ───────────────────────────────────────────────────────────────

export function evaluateSkillEvidence(
  declaredSkills: string[],
  fullText: string,
  sections: ResumeSection[]
): SkillSectionEvidence[] {
  const skillsSection = sections.find((s) => s.id === 'skills' || s.id.startsWith('skills-'));
  const nonSkillsText = skillsSection
    ? fullText.slice(0, skillsSection.start) + fullText.slice(skillsSection.end)
    : fullText;
  return declaredSkills.map((skill) => {
    const inExperienceOrProjects = skillAppearsInText(skill, nonSkillsText);
    const anywhere = skillAppearsInText(skill, fullText);
    return {
      skill,
      inExperienceOrProjects,
      inSkillsOnly: anywhere && !inExperienceOrProjects,
      notFound: !anywhere,
    };
  });
}

// ── entry point ──────────────────────────────────────────────────────────

export function runDeterministicAnalysis(rawText: unknown, declaredSkills: string[]): DeterministicResult {
  const text = normalizeResumeText(rawText);
  const sections = buildSectionMap(text);
  const bullets = extractBullets(text, sections);
  const dateRanges = extractDateRanges(text);
  return {
    sections,
    bullets,
    extractionSignals: extractionSignals(text),
    dateRanges,
    chronologyFindings: findChronologyIssues(dateRanges),
    duplicates: findDuplicateBullets(bullets),
    skillEvidence: evaluateSkillEvidence(declaredSkills, text, sections),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
  };
}
