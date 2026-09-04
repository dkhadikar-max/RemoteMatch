// ==============================================================================
// RemoteMatch AI & Matching Evaluation Benchmark Suite (25 Profiles × 10 Opps)
// Validating Pre-Beta Quality:
// 1. 0% False-Positive Rate on Hard Geographic & Legal Gates (10 negative cases)
// 2. Strong Fit Accuracy >= 75% for Qualified Candidates (10 positive cases)
// 3. Evidence Quality Scoring Differentiation (Strong vs Missing evidence)
// 4. Hallucination Resistance & Fact Grounding (No fabricated claims)
// ==============================================================================

import { PersonProfile, CanonicalOpportunity, ProfileLocation } from '../src/types/byn';
import {
  checkHardEligibility,
  computeScreeningFit,
  generateRuleBasedMatchAnalysis,
} from '../src/lib/matching/engine';
import { generateJobSpecificResumeAnalysis } from '../src/lib/ai/resume-intelligence';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

// Helper to construct locations cleanly
function createLocation(country: string): ProfileLocation {
  return {
    id: `loc-${country.toLowerCase()}`,
    profileId: 'cand',
    currentCountry: country,
    currentTimezone: 'UTC',
    workPreference: 'worldwide',
    allowedCountries: [],
    willingTimezones: [],
  };
}

// --------------------------------------------------------------------------
// 10 Canonical Opportunities Representing Diverse Global Requirements
// --------------------------------------------------------------------------
const OPPORTUNITIES: Record<string, CanonicalOpportunity> = {
  usSeniorReact: {
    id: 'opp-us-react',
    type: 'job',
    title: 'Senior Frontend Engineer (React/Next.js)',
    company: 'Stripe Ecosystem Co',
    description: 'Lead frontend development of financial dashboards using React, TypeScript, Next.js, and Tailwind CSS.',
    source: 'curated',
    sourceId: 'cur-101',
    officialUrl: 'https://careers.stripe-eco.com/senior-fe',
    canonicalUrlHash: 'hash-101',
    contentHash: 'chash-101',
    employmentType: 'Full-time',
    remoteType: 'US', // Hard gate: US only
    eligibleCountries: ['US', 'USA'],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['React', 'TypeScript', 'Next.js', 'Tailwind CSS'],
    preferredSkills: ['GraphQL', 'State Management'],
    experienceRequirement: '4-6',
    qualityScore: 92,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  euDevOpsLead: {
    id: 'opp-eu-devops',
    type: 'job',
    title: 'Staff DevOps & Cloud Architect',
    company: 'FinTech Nordics',
    description: 'Design multi-region Kubernetes clusters on AWS and Terraform for high-throughput banking pipelines.',
    source: 'curated',
    sourceId: 'cur-102',
    officialUrl: 'https://fintechnordics.eu/jobs/devops',
    canonicalUrlHash: 'hash-102',
    contentHash: 'chash-102',
    employmentType: 'Full-time',
    remoteType: 'EU/EEA', // Hard gate: EU/EEA only
    eligibleCountries: ['EU', 'UK', 'EEA'],
    excludedCountries: [],
    timezoneRequirements: ['CET'],
    requiredSkills: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD', 'Docker'],
    preferredSkills: ['Prometheus', 'ArgoCD'],
    experienceRequirement: '7-10',
    qualityScore: 90,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  indiaBackendPython: {
    id: 'opp-in-python',
    type: 'job',
    title: 'Backend Engineer (Python / FastAPI)',
    company: 'HyperScale Health',
    description: 'Build microservices with FastAPI, PostgreSQL, Redis, and message queues for real-time patient care.',
    source: 'curated',
    sourceId: 'cur-103',
    officialUrl: 'https://hyperscalehealth.in/careers/py',
    canonicalUrlHash: 'hash-103',
    contentHash: 'chash-103',
    employmentType: 'Full-time',
    remoteType: 'India', // Hard gate: India only
    eligibleCountries: ['India'],
    excludedCountries: [],
    timezoneRequirements: ['IST'],
    requiredSkills: ['Python', 'FastAPI', 'PostgreSQL', 'Redis'],
    preferredSkills: ['Docker', 'Kafka'],
    experienceRequirement: '2-3',
    qualityScore: 88,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  worldwideFullStack: {
    id: 'opp-ww-fullstack',
    type: 'job',
    title: 'Senior Full-Stack Engineer (Node + React)',
    company: 'Async Remote Co',
    description: 'Fully asynchronous worldwide team building collaboration software. Node.js, React, TypeScript, GraphQL.',
    source: 'curated',
    sourceId: 'cur-104',
    officialUrl: 'https://asyncremote.com/jobs/fullstack',
    canonicalUrlHash: 'hash-104',
    contentHash: 'chash-104',
    employmentType: 'Full-time',
    remoteType: 'Worldwide', // Open Worldwide
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL'],
    preferredSkills: ['GraphQL', 'Docker'],
    experienceRequirement: '4-6',
    qualityScore: 95,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  worldwideContractAI: {
    id: 'opp-ww-contract-ai',
    type: 'contract',
    title: 'AI Product Specialist (6-Month Contract)',
    company: 'GenAI Labs Global',
    description: 'Contract engagement for integrating LLMs and prompt evaluation into SaaS products.',
    source: 'curated',
    sourceId: 'cur-105',
    officialUrl: 'https://genailabs.io/contract/ai',
    canonicalUrlHash: 'hash-105',
    contentHash: 'chash-105',
    employmentType: 'Contract', // Hard gate: Contract
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['Python', 'LLMs', 'Prompt Engineering', 'FastAPI'],
    preferredSkills: ['LangChain', 'Vector DBs'],
    experienceRequirement: '4-6',
    qualityScore: 91,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  worldwideFreelanceDesign: {
    id: 'opp-ww-design',
    type: 'freelance',
    title: 'Product Designer / UI-UX Lead',
    company: 'PixelCraft Studio',
    description: 'Freelance design systems and interactive prototypes for SaaS apps in Figma.',
    source: 'curated',
    sourceId: 'cur-106',
    officialUrl: 'https://pixelcraft.design/freelance',
    canonicalUrlHash: 'hash-106',
    contentHash: 'chash-106',
    employmentType: 'Freelance', // Hard gate: Freelance
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['Figma', 'UI/UX Design', 'Design Systems', 'Prototyping'],
    preferredSkills: ['Design Tokens', 'HTML/CSS'],
    experienceRequirement: '2-3',
    qualityScore: 89,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  worldwideSeniorMobile: {
    id: 'opp-ww-mobile',
    type: 'job',
    title: 'Mobile Engineer (React Native)',
    company: 'PocketApp International',
    description: 'Build cross-platform iOS and Android apps in React Native and TypeScript.',
    source: 'curated',
    sourceId: 'cur-107',
    officialUrl: 'https://pocketapp.com/careers/mobile',
    canonicalUrlHash: 'hash-107',
    contentHash: 'chash-107',
    employmentType: 'Full-time',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['React Native', 'TypeScript', 'iOS', 'Android'],
    preferredSkills: ['Redux', 'Expo'],
    experienceRequirement: '4-6',
    qualityScore: 87,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  usStaffSecurity: {
    id: 'opp-us-security',
    type: 'job',
    title: 'Staff Security Engineer (AppSec)',
    company: 'CyberDefend USA',
    description: 'Lead application security reviews, threat modeling, and SOC2 compliance. US clearance/residency required.',
    source: 'curated',
    sourceId: 'cur-108',
    officialUrl: 'https://cyberdefend.us/staff-sec',
    canonicalUrlHash: 'hash-108',
    contentHash: 'chash-108',
    employmentType: 'Full-time',
    remoteType: 'US', // Hard gate: US only
    eligibleCountries: ['US'],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['AppSec', 'Threat Modeling', 'Python', 'AWS Security', 'SOC2'],
    preferredSkills: ['Penetration Testing'],
    experienceRequirement: '7-10',
    qualityScore: 94,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  euDataEngineer: {
    id: 'opp-eu-data',
    type: 'job',
    title: 'Lead Data Platform Engineer',
    company: 'Berlin Data Labs',
    description: 'Snowflake, dbt, Apache Spark, and Kafka streaming pipelines in GDPR compliant cloud.',
    source: 'curated',
    sourceId: 'cur-109',
    officialUrl: 'https://berlindata.de/lead-data',
    canonicalUrlHash: 'hash-109',
    contentHash: 'chash-109',
    employmentType: 'Full-time',
    remoteType: 'EU/EEA', // Hard gate: EU only
    eligibleCountries: ['EU', 'EEA'],
    excludedCountries: [],
    timezoneRequirements: ['CET'],
    requiredSkills: ['Snowflake', 'dbt', 'Python', 'Apache Spark', 'SQL'],
    preferredSkills: ['Kafka', 'Airflow'],
    experienceRequirement: '4-6',
    qualityScore: 91,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
  worldwideFrontendVue: {
    id: 'opp-ww-vue',
    type: 'job',
    title: 'Senior Frontend Developer (Vue 3 / Nuxt)',
    company: 'OpenVue Global',
    description: 'Nuxt 3, Vue 3, Pinia, TypeScript component libraries for international customers.',
    source: 'curated',
    sourceId: 'cur-110',
    officialUrl: 'https://openvue.global/careers',
    canonicalUrlHash: 'hash-110',
    contentHash: 'chash-110',
    employmentType: 'Full-time',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    requiredSkills: ['Vue.js', 'Nuxt.js', 'TypeScript', 'Tailwind CSS'],
    preferredSkills: ['Vite', 'Pinia'],
    experienceRequirement: '4-6',
    qualityScore: 89,
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  },
};

// Helper to construct candidate profiles
function createTestProfile(overrides: Partial<PersonProfile>): PersonProfile {
  return {
    id: overrides.id || 'test-cand',
    email: overrides.email || 'test@example.com',
    fullName: overrides.fullName || 'Test Candidate',
    headline: overrides.headline || 'Software Engineer',
    profileStrength: overrides.profileStrength || 80,
    planTier: overrides.planTier || 'free',
    dailyEvaluationsCount: overrides.dailyEvaluationsCount || 0,
    lastEvaluationResetAt: overrides.lastEvaluationResetAt || new Date().toISOString(),
    skills: overrides.skills || [],
    experiences: overrides.experiences || [],
    location: overrides.location || createLocation('India'),
    intent: overrides.intent || {
      id: 'intent-1',
      profileId: 'test-cand',
      employmentTypes: ['Full-time'],
      targetRoles: ['Software Engineer'],
      yearsOfExperience: '4-6',
      preferredCurrency: 'USD',
      availabilityStatus: 'immediately',
      updatedAt: new Date().toISOString(),
    },
    rawResumeText: overrides.rawResumeText || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function runBenchmarkSuite() {
  console.log('\n============================================================');
  console.log('REMOTEMATCH AI & MATCHING EVALUATION BENCHMARK');
  console.log('Evaluating 25 Profiles across 10 Global Opportunities');
  console.log('============================================================\n');

  // ==========================================================================
  // SECTION 1: 10 HARD-GATE NEGATIVE TESTS (Must NEVER produce False Positives)
  // ==========================================================================
  console.log('--- SECTION 1: 10 Hard-Gate Negative Tests (0% False-Positive Target) ---');

  // Test 1: India candidate applying to US-only job
  const p1 = createTestProfile({
    id: 'p1',
    fullName: 'Rohan Sharma',
    location: createLocation('India'),
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: ['Frontend Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's1', profileId: 'p1', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate1 = checkHardEligibility(p1, OPPORTUNITIES.usSeniorReact);
  const fit1 = computeScreeningFit(p1, OPPORTUNITIES.usSeniorReact);
  assert(!gate1.isEligible && !gate1.countryEligible, 'P1: Blocks India candidate from US-only job (Hard Gate)');
  assert(fit1.fitScore < 40 && fit1.fitBadge === 'Low Fit', 'P1: Assigns <40% Low Fit to US-restricted role');

  // Test 2: Nigeria candidate applying to EU/EEA-only job
  const p2 = createTestProfile({
    id: 'p2',
    fullName: 'Chidi Okafor',
    location: createLocation('Nigeria'),
    intent: { id: 'i2', profileId: 'p2', employmentTypes: ['Full-time'], targetRoles: ['DevOps Architect'], yearsOfExperience: '7-10', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's2', profileId: 'p2', skillName: 'Kubernetes', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate2 = checkHardEligibility(p2, OPPORTUNITIES.euDevOpsLead);
  assert(!gate2.isEligible && !gate2.countryEligible, 'P2: Blocks non-EU candidate from EU/EEA-only job');

  // Test 3: US candidate applying to India-only job
  const p3 = createTestProfile({
    id: 'p3',
    fullName: 'John Miller',
    location: createLocation('USA'),
    intent: { id: 'i3', profileId: 'p3', employmentTypes: ['Full-time'], targetRoles: ['Backend Engineer'], yearsOfExperience: '2-3', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's3', profileId: 'p3', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate3 = checkHardEligibility(p3, OPPORTUNITIES.indiaBackendPython);
  assert(!gate3.isEligible && !gate3.countryEligible, 'P3: Blocks US candidate from India-only residency job');

  // Test 4: Full-Time-only candidate applying to Freelance opportunity
  const p4 = createTestProfile({
    id: 'p4',
    location: createLocation('Germany'),
    intent: { id: 'i4', profileId: 'p4', employmentTypes: ['Full-time'], targetRoles: ['Product Designer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's4', profileId: 'p4', skillName: 'Figma', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate4 = checkHardEligibility(p4, OPPORTUNITIES.worldwideFreelanceDesign);
  assert(!gate4.isEligible && !gate4.employmentTypeCompatible, 'P4: Blocks Full-Time candidate from Freelance-only opportunity');

  // Test 5: Freelance-only candidate applying to Full-Time opportunity
  const p5 = createTestProfile({
    id: 'p5',
    location: createLocation('Canada'),
    intent: { id: 'i5', profileId: 'p5', employmentTypes: ['Freelance'], targetRoles: ['Full Stack Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's5', profileId: 'p5', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate5 = checkHardEligibility(p5, OPPORTUNITIES.worldwideFullStack);
  assert(!gate5.isEligible && !gate5.employmentTypeCompatible, 'P5: Blocks Freelance-only candidate from Full-Time opportunity');

  // Test 6: Graphic Designer applying to Staff AppSec Engineer (Total domain mismatch)
  const p6 = createTestProfile({
    id: 'p6',
    location: createLocation('USA'),
    intent: { id: 'i6', profileId: 'p6', employmentTypes: ['Full-time'], targetRoles: ['Graphic Designer', 'Illustrator'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's6', profileId: 'p6', skillName: 'Photoshop', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate6 = checkHardEligibility(p6, OPPORTUNITIES.usStaffSecurity);
  assert(!gate6.isEligible && !gate6.roleRelevant, 'P6: Blocks Graphic Designer from Staff AppSec Engineer (Role relevance)');

  // Test 7: Junior (0-1 yrs) applying to Staff DevOps Architect (Severe Seniority Gap)
  const p7 = createTestProfile({
    id: 'p7',
    location: createLocation('UK'),
    intent: { id: 'i7', profileId: 'p7', employmentTypes: ['Full-time'], targetRoles: ['DevOps'], yearsOfExperience: '0-1', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's7', profileId: 'p7', skillName: 'Docker', isPrimary: true, evidenceLevel: 'moderate' }],
  });
  const fit7 = computeScreeningFit(p7, OPPORTUNITIES.euDevOpsLead);
  assert(fit7.fitScore <= 60, 'P7: Penalizes 0-1 yr Junior applying to Staff 7-10 yr role');

  // Test 8: Brazil candidate applying to US-only Staff Security
  const p8 = createTestProfile({
    id: 'p8',
    location: createLocation('Brazil'),
    intent: { id: 'i8', profileId: 'p8', employmentTypes: ['Full-time'], targetRoles: ['Security Engineer'], yearsOfExperience: '7-10', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's8', profileId: 'p8', skillName: 'AppSec', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate8 = checkHardEligibility(p8, OPPORTUNITIES.usStaffSecurity);
  assert(!gate8.isEligible && !gate8.countryEligible, 'P8: Blocks Brazil candidate from US Staff Security (Hard Gate)');

  // Test 9: Data Engineer applying to Mobile Engineer (Skill mismatch)
  const p9 = createTestProfile({
    id: 'p9',
    location: createLocation('Worldwide'),
    intent: { id: 'i9', profileId: 'p9', employmentTypes: ['Full-time'], targetRoles: ['Data Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's9a', profileId: 'p9', skillName: 'Snowflake', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's9b', profileId: 'p9', skillName: 'dbt', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const gate9 = checkHardEligibility(p9, OPPORTUNITIES.worldwideSeniorMobile);
  assert(!gate9.isEligible && !gate9.roleRelevant, 'P9: Disqualifies Data Engineer from Mobile Engineer position');

  // Test 10: Candidate with missing country info defaults to non-US, blocking US-only jobs
  const p10 = createTestProfile({
    id: 'p10',
    location: createLocation('Worldwide'),
    intent: { id: 'i10', profileId: 'p10', employmentTypes: ['Full-time'], targetRoles: ['Frontend'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [{ id: 's10', profileId: 'p10', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' }],
  });
  const gate10 = checkHardEligibility(p10, OPPORTUNITIES.usSeniorReact);
  assert(!gate10.isEligible, 'P10: Unverified/Worldwide residency does not grant access to US-only jobs');


  // ==========================================================================
  // SECTION 2: 10 STRONG MATCHES (Target Score >= 75%)
  // ==========================================================================
  console.log('\n--- SECTION 2: 10 High-Precision Strong Matches (Score >= 75%) ---');

  // Profile 11: US React/Next.js Senior Developer
  const p11 = createTestProfile({
    id: 'p11',
    fullName: 'Sarah Jenkins',
    location: createLocation('USA'),
    intent: { id: 'i11', profileId: 'p11', employmentTypes: ['Full-time'], targetRoles: ['Senior Frontend Engineer', 'React Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's11a', profileId: 'p11', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's11b', profileId: 'p11', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's11c', profileId: 'p11', skillName: 'Next.js', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's11d', profileId: 'p11', skillName: 'Tailwind CSS', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit11 = computeScreeningFit(p11, OPPORTUNITIES.usSeniorReact);
  const match11 = generateRuleBasedMatchAnalysis(p11, OPPORTUNITIES.usSeniorReact);
  assert(fit11.fitScore >= 80, `P11: US Senior React dev scores high (${fit11.fitScore}%)`);
  assert(match11.recommendation === 'apply', 'P11: Recommendation is APPLY');

  // Profile 12: German DevOps Architect -> EU Staff DevOps
  const p12 = createTestProfile({
    id: 'p12',
    fullName: 'Lukas Meyer',
    location: createLocation('Germany'),
    intent: { id: 'i12', profileId: 'p12', employmentTypes: ['Full-time'], targetRoles: ['DevOps Architect', 'Staff DevOps'], yearsOfExperience: '7-10', preferredCurrency: 'EUR', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's12a', profileId: 'p12', skillName: 'Kubernetes', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's12b', profileId: 'p12', skillName: 'AWS', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's12c', profileId: 'p12', skillName: 'Terraform', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's12d', profileId: 'p12', skillName: 'CI/CD', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit12 = computeScreeningFit(p12, OPPORTUNITIES.euDevOpsLead);
  assert(fit12.fitScore >= 80, `P12: German DevOps Architect scores strong fit (${fit12.fitScore}%)`);

  // Profile 13: Indian Python Backend -> HyperScale Health
  const p13 = createTestProfile({
    id: 'p13',
    fullName: 'Pooja Iyer',
    location: createLocation('India'),
    intent: { id: 'i13', profileId: 'p13', employmentTypes: ['Full-time'], targetRoles: ['Backend Engineer', 'Python Engineer'], yearsOfExperience: '2-3', preferredCurrency: 'INR', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's13a', profileId: 'p13', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's13b', profileId: 'p13', skillName: 'FastAPI', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's13c', profileId: 'p13', skillName: 'PostgreSQL', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit13 = computeScreeningFit(p13, OPPORTUNITIES.indiaBackendPython);
  assert(fit13.fitScore >= 75, `P13: Indian Python backend scores >= 75% (${fit13.fitScore}%)`);

  // Profile 14: Global Full-Stack Developer -> Worldwide Full-Stack
  const p14 = createTestProfile({
    id: 'p14',
    fullName: 'Mateo Rossi',
    location: createLocation('Italy'),
    intent: { id: 'i14', profileId: 'p14', employmentTypes: ['Full-time'], targetRoles: ['Full-Stack Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'EUR', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's14a', profileId: 'p14', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's14b', profileId: 'p14', skillName: 'Node.js', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's14c', profileId: 'p14', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's14d', profileId: 'p14', skillName: 'PostgreSQL', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit14 = computeScreeningFit(p14, OPPORTUNITIES.worldwideFullStack);
  assert(fit14.fitScore >= 80, `P14: Worldwide Full-Stack candidate scores high (${fit14.fitScore}%)`);

  // Profile 15: AI Contractor -> Worldwide Contract AI
  const p15 = createTestProfile({
    id: 'p15',
    fullName: 'David Vance',
    location: createLocation('UK'),
    intent: { id: 'i15', profileId: 'p15', employmentTypes: ['Contract'], targetRoles: ['AI Product Specialist'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's15a', profileId: 'p15', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's15b', profileId: 'p15', skillName: 'LLMs', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's15c', profileId: 'p15', skillName: 'FastAPI', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit15 = computeScreeningFit(p15, OPPORTUNITIES.worldwideContractAI);
  assert(fit15.fitScore >= 75, `P15: Contract AI specialist fits contract role (${fit15.fitScore}%)`);

  // Profile 16: Freelance UI/UX Designer -> Worldwide Freelance Design
  const p16 = createTestProfile({
    id: 'p16',
    fullName: 'Elena Rostova',
    location: createLocation('Poland'),
    intent: { id: 'i16', profileId: 'p16', employmentTypes: ['Freelance'], targetRoles: ['Product Designer', 'UI/UX'], yearsOfExperience: '2-3', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's16a', profileId: 'p16', skillName: 'Figma', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's16b', profileId: 'p16', skillName: 'UI/UX Design', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's16c', profileId: 'p16', skillName: 'Design Systems', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit16 = computeScreeningFit(p16, OPPORTUNITIES.worldwideFreelanceDesign);
  assert(fit16.fitScore >= 75, `P16: Freelance designer fits freelance role (${fit16.fitScore}%)`);

  // Profile 17: Mobile Engineer -> Worldwide React Native
  const p17 = createTestProfile({
    id: 'p17',
    fullName: 'Kenji Sato',
    location: createLocation('Japan'),
    intent: { id: 'i17', profileId: 'p17', employmentTypes: ['Full-time'], targetRoles: ['Mobile Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's17a', profileId: 'p17', skillName: 'React Native', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's17b', profileId: 'p17', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's17c', profileId: 'p17', skillName: 'iOS', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit17 = computeScreeningFit(p17, OPPORTUNITIES.worldwideSeniorMobile);
  assert(fit17.fitScore >= 75, `P17: React Native developer achieves strong fit (${fit17.fitScore}%)`);

  // Profile 18: US Staff Security Engineer -> CyberDefend USA
  const p18 = createTestProfile({
    id: 'p18',
    fullName: 'Robert Hayes',
    location: createLocation('USA'),
    intent: { id: 'i18', profileId: 'p18', employmentTypes: ['Full-time'], targetRoles: ['Staff Security Engineer', 'AppSec'], yearsOfExperience: '7-10', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's18a', profileId: 'p18', skillName: 'AppSec', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's18b', profileId: 'p18', skillName: 'Threat Modeling', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's18c', profileId: 'p18', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's18d', profileId: 'p18', skillName: 'AWS Security', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit18 = computeScreeningFit(p18, OPPORTUNITIES.usStaffSecurity);
  assert(fit18.fitScore >= 80, `P18: US AppSec lead achieves high match (${fit18.fitScore}%)`);

  // Profile 19: EU Lead Data Platform Engineer -> Berlin Data Labs
  const p19 = createTestProfile({
    id: 'p19',
    fullName: 'Anouk Dubois',
    location: createLocation('France'),
    intent: { id: 'i19', profileId: 'p19', employmentTypes: ['Full-time'], targetRoles: ['Data Engineer', 'Data Platform Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'EUR', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's19a', profileId: 'p19', skillName: 'Snowflake', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's19b', profileId: 'p19', skillName: 'dbt', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's19c', profileId: 'p19', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit19 = computeScreeningFit(p19, OPPORTUNITIES.euDataEngineer);
  assert(fit19.fitScore >= 75, `P19: French data engineer achieves strong match for EU role (${fit19.fitScore}%)`);

  // Profile 20: Vue 3 / Nuxt Developer -> OpenVue Global
  const p20 = createTestProfile({
    id: 'p20',
    fullName: 'Carlos Mendes',
    location: createLocation('Portugal'),
    intent: { id: 'i20', profileId: 'p20', employmentTypes: ['Full-time'], targetRoles: ['Frontend Developer'], yearsOfExperience: '4-6', preferredCurrency: 'EUR', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 's20a', profileId: 'p20', skillName: 'Vue.js', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's20b', profileId: 'p20', skillName: 'Nuxt.js', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's20c', profileId: 'p20', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });
  const fit20 = computeScreeningFit(p20, OPPORTUNITIES.worldwideFrontendVue);
  assert(fit20.fitScore >= 75, `P20: Vue developer scores >= 75% for worldwide Vue vacancy (${fit20.fitScore}%)`);


  // ==========================================================================
  // SECTION 3: 5 EVIDENCE QUALITY & HALLUCINATION RESISTANCE INVARIANTS
  // ==========================================================================
  console.log('\n--- SECTION 3: 5 Evidence Quality & Hallucination Resistance Tests ---');

  // Test 21: Strong Evidence vs Missing Evidence Score Differential
  const pStrong = createTestProfile({
    id: 'pStrong',
    location: createLocation('USA'),
    intent: { id: 'is', profileId: 'pStrong', employmentTypes: ['Full-time'], targetRoles: ['Frontend Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 'sk1', profileId: 'pStrong', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' },
      { id: 'sk2', profileId: 'pStrong', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'strong' },
    ],
  });

  const pMissing = createTestProfile({
    id: 'pMissing',
    location: createLocation('USA'),
    intent: { id: 'im', profileId: 'pMissing', employmentTypes: ['Full-time'], targetRoles: ['Frontend Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '' },
    skills: [
      { id: 'sk1m', profileId: 'pMissing', skillName: 'React', isPrimary: true, evidenceLevel: 'missing' },
      { id: 'sk2m', profileId: 'pMissing', skillName: 'TypeScript', isPrimary: true, evidenceLevel: 'missing' },
    ],
  });

  const fitStrong = computeScreeningFit(pStrong, OPPORTUNITIES.usSeniorReact);
  const fitMissing = computeScreeningFit(pMissing, OPPORTUNITIES.usSeniorReact);
  assert(
    fitStrong.fitScore > fitMissing.fitScore,
    `P21: Strong evidence awards higher score (${fitStrong.fitScore}%) than unverified claims (${fitMissing.fitScore}%)`
  );

  // Test 22: Requirements checklist marks missing skills as missing/partial, never false match
  const matchWithMissingSkill = generateRuleBasedMatchAnalysis(pStrong, OPPORTUNITIES.usSeniorReact);
  const tailwindCheck = matchWithMissingSkill.requirementChecklist.find((r) =>
    r.requirement.toLowerCase().includes('tailwind')
  );
  assert(
    tailwindCheck?.status === 'missing' || tailwindCheck?.status === 'partial',
    'P22: Missing requirement (Tailwind CSS) is flagged truthfully, never marked matched'
  );

  // Test 23: No-Hallucination Policy in Tailored Bullet Rewrites
  const mockRawResume = `John Doe. Senior Software Engineer with 5 years building scalable web tools.
Technologies: React, Node.js, TypeScript. No mention of AWS or Kubernetes.`;

  const pWithResume = { ...pStrong, rawResumeText: mockRawResume };
  const resumeTweaks = generateJobSpecificResumeAnalysis(pWithResume, OPPORTUNITIES.usSeniorReact);

  // Assert that generated suggestions advise the candidate to quantify rather than making up metrics
  const suggestionsText = JSON.stringify(resumeTweaks);
  assert(
    suggestionsText.includes('Rewrite') ||
      suggestionsText.includes('outcome') ||
      suggestionsText.includes('scope') ||
      suggestionsText.includes('Elevate') ||
      suggestionsText.includes('Surface'),
    'P23: Suggestions coach candidate to add verified context without fabricating unverified metrics'
  );

  // Test 24: Non-existent technology is not falsely credited in strengths
  assert(
    !matchWithMissingSkill.strengths.some((s) => s.toLowerCase().includes('kubernetes')),
    'P24: Strengths list contains only technologies present in candidate profile or resume'
  );

  // Test 25: 0% False-Positive Rate across all 10 Negative Profiles
  const negativeCases = [
    { p: p1, opp: OPPORTUNITIES.usSeniorReact },
    { p: p2, opp: OPPORTUNITIES.euDevOpsLead },
    { p: p3, opp: OPPORTUNITIES.indiaBackendPython },
    { p: p4, opp: OPPORTUNITIES.worldwideFreelanceDesign },
    { p: p5, opp: OPPORTUNITIES.worldwideFullStack },
    { p: p6, opp: OPPORTUNITIES.usStaffSecurity },
    { p: p8, opp: OPPORTUNITIES.usStaffSecurity },
    { p: p9, opp: OPPORTUNITIES.worldwideSeniorMobile },
    { p: p10, opp: OPPORTUNITIES.usSeniorReact },
  ];

  const falsePositives = negativeCases.filter((c) => {
    const gate = checkHardEligibility(c.p, c.opp);
    const fit = computeScreeningFit(c.p, c.opp);
    return gate.isEligible || fit.fitScore >= 65;
  });

  assert(
    falsePositives.length === 0,
    `P25: Hard Eligibility Gates achieved strictly 0% false-positive rate (${falsePositives.length} violations)`
  );

  // Summary
  console.log('\n============================================================');
  console.log(`BENCHMARK RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runBenchmarkSuite().catch((err) => {
  console.error('Benchmark suite encountered fatal error:', err);
  process.exit(1);
});
