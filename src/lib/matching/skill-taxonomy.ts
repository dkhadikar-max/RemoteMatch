/**
 * Curated, conservative skill taxonomy for RemoteMatch.
 *
 * Only true spelling/abbreviation equivalences are canonicalized here.
 * Related-but-distinct concepts (SQL/PostgreSQL, Java/JavaScript,
 * React/Frontend, C/C++) intentionally remain distinct. Broader role and
 * capability relationships belong in separately evaluated retrieval features.
 */
const SKILL_CANONICAL_FORMS: Record<string, string> = {
  "node.js": "nodejs",
  "node js": "nodejs",
  "golang": "go",
  "k8s": "kubernetes",
  "js": "javascript",
  "ts": "typescript",
  "py": "python",
  "postgres": "postgresql",
  "postgresql": "postgresql",
  "amazon web services": "aws",
  "google cloud platform": "gcp",
  "google cloud": "gcp",
  "microsoft azure": "azure",
  "c sharp": "c#",
  "c-sharp": "c#",
  "c plus plus": "c++",
  "cplusplus": "c++",
  "dotnet": ".net",
  "dot net": ".net",
  "machine-learning": "machine learning",
  "ml": "machine learning",
  "artificial intelligence": "ai",
  "ui/ux": "ui ux",
  "user experience": "ux",
  "user interface": "ui",
};

export function normalizeSkillLabel(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/\\s+/g, " ");
}

/** Returns a canonical key only for vetted aliases; otherwise normalized text. */
export function canonicalSkillKey(raw: string): string {
  const normalized = normalizeSkillLabel(raw);
  return SKILL_CANONICAL_FORMS[normalized] ?? normalized;
}

/** Exposed for audit/tests and future taxonomy curation. */
export function isKnownSkillAlias(raw: string): boolean {
  const normalized = normalizeSkillLabel(raw);
  return Object.prototype.hasOwnProperty.call(SKILL_CANONICAL_FORMS, normalized);
}
