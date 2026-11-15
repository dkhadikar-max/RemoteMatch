import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scoreOpportunitiesForFeed } from "../src/lib/matching/engine";
import { retrieveHybridCandidates } from "../src/lib/matching/hybrid-retrieval";
import type { CanonicalOpportunity, PersonProfile } from "../src/types/byn";

type EvaluationCase = {
  id: string;
  profile: PersonProfile;
  opportunities: CanonicalOpportunity[];
  relevantOpportunityIds: string[];
};
type EvaluationDataset = {
  version: string;
  description: string;
  cases: EvaluationCase[];
};

const K_PRECISION = 10;
const K_NDCG = 10;
const K_RECALL = 50;
const MIN_RECOMMENDED_CASES = 30;

function assertDataset(dataset: EvaluationDataset): void {
  if (!dataset || typeof dataset.version !== "string" || !Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error("Evaluation dataset must include a version and at least one judged case. Do not report metrics from an empty or synthetic-only dataset.");
  }
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || caseIds.has(item.id)) throw new Error(`Missing or duplicate case id: ${item.id}`);
    caseIds.add(item.id);
    if (!Array.isArray(item.opportunities) || item.opportunities.length === 0) throw new Error(`Case ${item.id} has no opportunities`);
    if (!Array.isArray(item.relevantOpportunityIds) || item.relevantOpportunityIds.length === 0) throw new Error(`Case ${item.id} has no relevance judgments`);
    const ids = item.opportunities.map((opportunity) => opportunity.id);
    if (new Set(ids).size !== ids.length) throw new Error(`Case ${item.id} has duplicate opportunity ids`);
    const candidateIds = new Set(ids);
    const missingJudgments = item.relevantOpportunityIds.filter((id) => !candidateIds.has(id));
    if (missingJudgments.length) throw new Error(`Case ${item.id} has relevance labels outside its candidate set: ${missingJudgments.join(", ")}`);
  }
}

function precisionAt(ranked: string[], relevant: Set<string>, k: number): number {
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / k;
}
function recallAt(ranked: string[], relevant: Set<string>, k: number): number {
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}
function dcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  return ranked.slice(0, k).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
}
function ndcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  const ideal = Array.from({ length: Math.min(relevant.size, k) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : dcgAt(ranked, relevant, k) / ideal;
}
function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx test/evaluate-hybrid-retrieval.ts <path-to-judged-dataset.json>");
  console.error("Dataset schema: { version, description, cases: [{ id, profile, opportunities, relevantOpportunityIds }] }");
  process.exit(2);
}

const dataset = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as EvaluationDataset;
assertDataset(dataset);

const rows = dataset.cases.map((item) => {
  const relevant = new Set(item.relevantOpportunityIds);
  const legacy = scoreOpportunitiesForFeed(item.profile, item.opportunities).map((opportunity) => opportunity.id);
  const hybrid = retrieveHybridCandidates(item.profile, item.opportunities).map((result) => result.opportunity.id);
  const legacyTop10 = legacy.slice(0, K_PRECISION);
  const hybridTop10 = hybrid.slice(0, K_PRECISION);
  const hybridTop50 = new Set(hybrid.slice(0, K_RECALL));
  const legacyTop10CoverageInHybridTop50 = legacyTop10.length
    ? legacyTop10.filter((id) => hybridTop50.has(id)).length / legacyTop10.length
    : 1;
  const top10Intersection = hybridTop10.filter((id) => legacyTop10.includes(id)).length;
  const top10Union = new Set([...legacyTop10, ...hybridTop10]).size;
  const top10Overlap = top10Union ? top10Intersection / top10Union : 1;
  return {
    id: item.id,
    legacy: {
      precisionAt10: precisionAt(legacy, relevant, K_PRECISION),
      recallAt50: recallAt(legacy, relevant, K_RECALL),
      ndcgAt10: ndcgAt(legacy, relevant, K_NDCG),
    },
    hybrid: {
      precisionAt10: precisionAt(hybrid, relevant, K_PRECISION),
      recallAt50: recallAt(hybrid, relevant, K_RECALL),
      ndcgAt10: ndcgAt(hybrid, relevant, K_NDCG),
    },
    legacyTop10CoverageInHybridTop50,
    top10Overlap,
    candidateCount: item.opportunities.length,
    relevantCount: relevant.size,
  };
});

const aggregate = (key: "precisionAt10" | "recallAt50" | "ndcgAt10") => ({
  legacy: mean(rows.map((row) => row.legacy[key])),
  hybrid: mean(rows.map((row) => row.hybrid[key])),
  delta: mean(rows.map((row) => row.hybrid[key])) - mean(rows.map((row) => row.legacy[key])),
});
const summary = {
  datasetVersion: dataset.version,
  datasetDescription: dataset.description,
  judgedCases: rows.length,
  meanCandidateCount: mean(rows.map((row) => row.candidateCount)),
  meanRelevantCount: mean(rows.map((row) => row.relevantCount)),
  precisionAt10: aggregate("precisionAt10"),
  recallAt50: aggregate("recallAt50"),
  ndcgAt10: aggregate("ndcgAt10"),
  legacyTop10CoverageInHybridTop50: mean(rows.map((row) => row.legacyTop10CoverageInHybridTop50)),
  top10JaccardParity: mean(rows.map((row) => row.top10Overlap)),
  perCase: rows,
  interpretation: rows.length < MIN_RECOMMENDED_CASES
    ? `INSUFFICIENT SAMPLE: ${MIN_RECOMMENDED_CASES}+ judged profile/query cases are recommended before making a rollout decision.`
    : "Metrics are descriptive; inspect per-case regressions and confidence intervals before rollout.",
};
console.log(JSON.stringify(summary, null, 2));
