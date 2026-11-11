import type { CanonicalOpportunity, PersonProfile } from "@/types/byn";
import { canonicalSkillKey, normalizeSkillLabel } from "./skill-taxonomy";

export type RetrievalChannel = "skill_exact" | "skill_alias" | "role_title" | "lexical";

export interface RetrievalEvidence {
  channel: RetrievalChannel;
  score: number;
  matchedTerms: string[];
}

export interface RetrievedOpportunity<T extends CanonicalOpportunity = CanonicalOpportunity> {
  opportunity: T;
  score: number;
  evidence: RetrievalEvidence[];
  originalIndex: number;
}

export interface HybridRetrievalOptions {
  /** Return at most this many candidates. Omit to preserve the full candidate set. */
  limit?: number;
  /** Minimum score. Defaults to 0, so the default call never drops candidates. */
  minScore?: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "of", "on", "or", "the", "to", "with", "work", "working", "role",
]);

function tokens(value: string): string[] {
  return normalizeSkillLabel(value)
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function bm25LikeScore(queryTerms: string[], fields: Array<{ text: string; weight: number }>, documentFrequency: Map<string, number>, documentCount: number): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;
  const termFrequency = new Map<string, number>();
  for (const field of fields) {
    const counts = new Map<string, number>();
    for (const token of tokens(field.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, count] of counts) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + count * field.weight);
    }
  }
  for (const term of unique(queryTerms)) {
    const tf = termFrequency.get(term) ?? 0;
    if (tf === 0) continue;
    matched.push(term);
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    score += idf * (tf * 2.2) / (tf + 1.2);
  }
  return { score, matched };
}

/**
 * Conservative hybrid candidate generation for shadow evaluation.
 *
 * Channels are independent evidence: exact canonical skill overlap,
 * role-title lexical overlap, and BM25-like weighted lexical relevance.
 * This is NOT a trained semantic model and does not claim vector similarity.
 * With no limit/minScore, every input opportunity is returned, preserving
 * candidate-set recall while the team measures ranking parity.
 */
export function retrieveHybridCandidates<T extends CanonicalOpportunity>(
  profile: Pick<PersonProfile, "skills" | "intent">,
  opportunities: T[],
  options: HybridRetrievalOptions = {},
): RetrievedOpportunity<T>[] {
  const profileSkills = unique((profile.skills ?? []).map((skill) => canonicalSkillKey(skill.skillName)).filter(Boolean));
  const targetRoles = unique((profile.intent?.targetRoles ?? []).map(normalizeSkillLabel).filter(Boolean));
  const queryTerms = unique([...profileSkills.flatMap(tokens), ...targetRoles.flatMap(tokens)]);
  const documents = opportunities.map((opportunity) => {
    const required = unique((opportunity.requiredSkills ?? []).map(canonicalSkillKey).filter(Boolean));
    const preferred = unique((opportunity.preferredSkills ?? []).map(canonicalSkillKey).filter(Boolean));
    const title = normalizeSkillLabel(opportunity.title ?? "");
    const description = normalizeSkillLabel(opportunity.description ?? "");
    const fields = [
      { text: title, weight: 3.0 },
      { text: required.join(" "), weight: 3.5 },
      { text: preferred.join(" "), weight: 1.75 },
      { text: description, weight: 0.35 },
    ];
    return { required, title, fields };
  });

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    const terms = unique(document.fields.flatMap((field) => tokens(field.text)));
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const scored = opportunities.map((opportunity, originalIndex) => {
    const document = documents[originalIndex];
    const evidence: RetrievalEvidence[] = [];
    const exactSkills = profileSkills.filter((skill) => document.required.includes(skill));
    if (exactSkills.length) evidence.push({ channel: "skill_exact", score: exactSkills.length * 8, matchedTerms: exactSkills });

    const rawProfileSkills = (profile.skills ?? []).map((skill) => normalizeSkillLabel(skill.skillName));
    const rawRequired = (opportunity.requiredSkills ?? []).map(normalizeSkillLabel);
    const aliasMatches = profileSkills.filter((skill) =>
      rawRequired.some((raw) => canonicalSkillKey(raw) === skill) &&
      !rawProfileSkills.includes(skill),
    );
    if (aliasMatches.length) evidence.push({ channel: "skill_alias", score: aliasMatches.length * 7, matchedTerms: aliasMatches });

    const roleTerms = unique(targetRoles.flatMap(tokens));
    const titleTerms = new Set(tokens(document.title));
    const roleMatches = roleTerms.filter((term) => titleTerms.has(term));
    if (roleMatches.length) evidence.push({ channel: "role_title", score: roleMatches.length * 2.5, matchedTerms: roleMatches });

    const lexical = bm25LikeScore(queryTerms, document.fields, documentFrequency, opportunities.length);
    if (lexical.score > 0) evidence.push({ channel: "lexical", score: lexical.score, matchedTerms: lexical.matched });

    const score = evidence.reduce((sum, item) => sum + item.score, 0);
    return { opportunity, score, evidence, originalIndex };
  });

  const minScore = options.minScore ?? 0;
  const ranked = scored
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  return typeof options.limit === "number" ? ranked.slice(0, Math.max(0, options.limit)) : ranked;
}
