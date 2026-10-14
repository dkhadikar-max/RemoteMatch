/**
 * Does a declared skill literally appear in a piece of resume text? — one safe, tested matcher.
 * ==============================================================================
 * This is a TEXT SEARCH. It says "this word/phrase appears in the text you pasted", nothing more: it does not assess
 * experience, quality or recency, and absence can simply mean different wording ("JS" vs "JavaScript").
 *
 * Replaces ad-hoc checks that were wrong in both directions (audit R-P1-1/R-P1-2):
 *  - `new RegExp('\\b' + skill.replace('.', '\\.') + '\\b')` escaped only the FIRST dot, so "C++" threw
 *    `SyntaxError: Nothing to repeat`, and `\b` cannot sit next to "+", "#" or "." so C# / .NET were never found;
 *  - raw `includes()` found "Go" in "going"/"google", "Java" in "JavaScript", "R" in any word.
 *
 * Rules
 *  - Never throws; garbage in → false.
 *  - Every regex metacharacter in a skill is escaped (it is data, not a pattern).
 *  - A term matches only as a whole token: not glued to letters/digits/underscore on either side.
 *  - Short terms (≤ 2 chars: "C", "R", "Go") are ambiguous English/letters, so they match CASE-SENSITIVELY, are never
 *    taken from inside "C++"/"C#"/"R&D"/"C-level", and "Go" also accepts "Golang".
 *  - A small alias table maps common spellings (Node.js/nodejs, Postgres/PostgreSQL, k8s/Kubernetes, C++/cpp, .NET/dotnet…).
 *  - Residual limitation (documented, not hidden): a sentence-initial capitalised "Go" ("Go to market") is a false
 *    positive for the skill "Go"; the matcher stays conservative elsewhere.
 */

const MAX_SKILL_LENGTH = 80;
const MAX_TEXT_LENGTH = 400_000;

/** lower-case skill → extra spellings that count as the same skill. */
const ALIASES: Record<string, string[]> = {
  'node.js': ['nodejs', 'node js'],
  'next.js': ['nextjs', 'next js'],
  'vue.js': ['vuejs', 'vue js'],
  'react': ['reactjs', 'react.js'],
  'react.js': ['react', 'reactjs'],
  'express.js': ['expressjs'],
  'postgresql': ['postgres'],
  'postgres': ['postgresql'],
  'mongodb': ['mongo db'],
  'kubernetes': ['k8s'],
  'k8s': ['kubernetes'],
  'c++': ['cpp'],
  'c#': ['csharp', 'c sharp'],
  '.net': ['dotnet', 'asp.net', '.net core'],
  'ci/cd': ['ci cd', 'cicd', 'ci-cd'],
  // Short alias keeps its canonical capitalisation: "Go" is matched case-sensitively (see termRegex).
  'golang': ['Go'],
  'go': ['golang'],
  'tailwind css': ['tailwind', 'tailwindcss'],
  'amazon web services': ['aws'],
  'aws': ['amazon web services'],
  'gcp': ['google cloud', 'google cloud platform'],
  'javascript': [],
  'typescript': [],
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/** Normalise text for searching: NFKC (ligatures, full-width), strip control chars, collapse spaces. */
export function normalizeResumeText(text: unknown): string {
  if (typeof text !== 'string') return '';
  let t = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  try { t = t.normalize('NFKC'); } catch { /* keep t */ }
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/[ \t ]+/g, ' ');
}

function termRegex(term: string): RegExp | null {
  const t = term.trim();
  if (!t || t.length > MAX_SKILL_LENGTH) return null;
  const short = t.length <= 2;
  const last = t[t.length - 1];
  const body = escapeRegex(t).replace(/\s+/g, '\\s+');

  // Leading edge: not glued to a word character; short terms also not after "&" or "x-" ("R&D", "re-R").
  const lead = short ? '(?<![A-Za-z0-9_&]|[A-Za-z]-)' : '(?<![A-Za-z0-9_])';
  // Trailing edge. Terms that END in + or # (C++, C#, F#) allow digits after ("C++17") but not letters/+/#.
  // Short alphanumeric terms (C, R, Go) must not be followed by + # & or "-letter" (so C != C++/C#, R != R&D, C != C-level).
  const trail = !isWordChar(last) ? '(?![A-Za-z_+#])' : short ? '(?![A-Za-z0-9_+#&]|-[A-Za-z])' : '(?![A-Za-z0-9_])';
  try {
    return new RegExp(`${lead}${body}${trail}`, short ? '' : 'i');
  } catch {
    return null; // an unbuildable pattern must never take the page down
  }
}

/** True iff `skill` (or a known alias) appears as a whole token in `text`. Never throws. */
export function skillAppearsInText(skill: unknown, text: unknown): boolean {
  try {
    if (typeof skill !== 'string') return false;
    const s = skill.normalize('NFKC').trim();
    if (!s || s.length > MAX_SKILL_LENGTH) return false;
    const haystack = normalizeResumeText(text);
    if (!haystack.trim()) return false;

    const key = s.toLowerCase();
    const terms = [s, ...(ALIASES[key] ?? [])];
    for (const term of terms) {
      const isAlias = term !== s;
      // An alias of a short/ambiguous skill follows its own length rule ("go" ← "golang" is long and case-insensitive).
      const re = termRegex(isAlias ? term : s);
      if (re && re.test(haystack)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
