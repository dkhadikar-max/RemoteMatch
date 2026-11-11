import { canonicalSkillKey, isKnownSkillAlias } from "../src/lib/matching/skill-taxonomy";
import { retrieveHybridCandidates } from "../src/lib/matching/hybrid-retrieval";
import type { CanonicalOpportunity, PersonProfile } from "../src/types/byn";

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log("PASS", label); }
  else { failed++; console.error("FAIL", label); }
}

function opportunity(id: string, title: string, requiredSkills: string[], description = ""): CanonicalOpportunity {
  return {
    id, type: "job", title, company: "Test", description, source: "test", sourceId: id,
    officialUrl: "https://example.com/" + id, canonicalUrlHash: id, contentHash: id,
    employmentType: "Full-time", remoteType: "Worldwide", eligibleCountries: [],
    excludedCountries: [], timezoneRequirements: [], requiredSkills, preferredSkills: [],
    qualityScore: 80, status: "active",
  } as CanonicalOpportunity;
}
const profile = {
  skills: [{ skillName: "Node.js" }, { skillName: "K8s" }, { skillName: "TypeScript" }],
  intent: { targetRoles: ["Backend Engineer"] },
} as unknown as Pick<PersonProfile, "skills" | "intent">;

assert(canonicalSkillKey("Node.js") === "nodejs", "Node.js canonicalizes");
assert(canonicalSkillKey("golang") === "go", "Golang canonicalizes to Go");
assert(canonicalSkillKey("K8s") === "kubernetes", "K8s canonicalizes");
assert(canonicalSkillKey("JavaScript") !== canonicalSkillKey("Java"), "Java and JavaScript remain distinct");
assert(canonicalSkillKey("SQL") !== canonicalSkillKey("PostgreSQL"), "SQL and PostgreSQL remain distinct");
assert(canonicalSkillKey("React") !== canonicalSkillKey("Frontend"), "React and frontend remain distinct");
assert(isKnownSkillAlias("Google Cloud Platform"), "known alias can be audited");

const jobs = [
  opportunity("a", "Backend Engineer", ["Node.js", "Kubernetes", "TypeScript"]),
  opportunity("b", "Frontend Engineer", ["React", "CSS"]),
  opportunity("c", "Data Analyst", ["SQL", "Python"]),
  opportunity("d", "Platform Engineer", ["Go", "K8s"], "Build internal cloud infrastructure"),
];
const results = retrieveHybridCandidates(profile, jobs);
assert(results.length === jobs.length, "default shadow retrieval preserves every candidate");
assert(results[0].opportunity.id === "a", "exact skills and target role rank the strongest match first");
assert(results.some((item) => item.opportunity.id === "d" && item.evidence.some((e) => e.channel === "skill_exact")), "canonical skill matches create exact evidence");
const aliasProfile = { skills: [{ skillName: "Node.js" }], intent: { targetRoles: ["Backend Engineer"] } } as unknown as Pick<PersonProfile, "skills" | "intent">;
const aliasJob = opportunity("alias", "Backend Engineer", ["nodejs"]);
const aliasResult = retrieveHybridCandidates(aliasProfile, [aliasJob])[0];
assert(aliasResult.evidence.some((e) => e.channel === "skill_alias"), "different spellings of the same canonical skill create alias evidence");
assert(retrieveHybridCandidates(profile, jobs, { limit: 2 }).length === 2, "optional top-K is bounded");
assert(retrieveHybridCandidates(profile, jobs, { minScore: 999 }).length === 0, "explicit threshold can filter candidates");
assert(results.every((item, index) => item.originalIndex === jobs.indexOf(item.opportunity)), "original input position is retained for parity analysis");

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
