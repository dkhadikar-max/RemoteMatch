/**
 * Repeatable main-feed matcher benchmark.
 *
 * Run: npx tsx test/main-feed-benchmark.ts
 * Optional: REMOTEMATCH_BENCH_ITERATIONS=7
 *
 * This measures the current in-process matcher only. It does not claim to
 * measure Supabase retrieval, HTTP serialization, personalization, or RSS.
 */
import { performance } from 'node:perf_hooks';
import { PersonProfile, CanonicalOpportunity } from '../src/types/byn';
import { scoreOpportunitiesForFeed } from '../src/lib/matching/engine';

const iterations = Math.max(3, Math.min(15, Number(process.env.REMOTEMATCH_BENCH_ITERATIONS ?? 5)));
const sizes = [25_000, 50_000, 100_000];

const profile = {
  id: 'benchmark-profile', email: 'benchmark@example.test', fullName: 'Benchmark',
  planTier: 'free', dailyEvaluationsCount: 0, lastEvaluationResetAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  intent: { id: 'intent', profileId: 'benchmark-profile', employmentTypes: ['Full-time'],
    targetRoles: ['Frontend Engineer', 'Software Engineer'], yearsOfExperience: '4-6',
    minSalary: 0, preferredCurrency: 'USD', availabilityStatus: 'immediately',
    updatedAt: '2026-11-01T00:00:00.000Z' },
  skills: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS'].map((skillName, i) => ({
    id: `skill-${i}`, profileId: 'benchmark-profile', skillName, yearsUsed: 4,
    isPrimary: true, evidenceLevel: 'strong' as const,
  })),
  experiences: [],
  location: { id: 'location', profileId: 'benchmark-profile', currentCountry: 'India',
    currentTimezone: 'Asia/Kolkata', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
} as unknown as PersonProfile;

function makeJobs(count: number): CanonicalOpportunity[] {
  const skills = [
    ['React', 'TypeScript', 'Next.js'],
    ['Python', 'Django', 'PostgreSQL'],
    ['Node.js', 'AWS', 'Docker'],
    ['Java', 'Spring', 'Kubernetes'],
    ['React', 'GraphQL', 'PostgreSQL'],
  ];
  return Array.from({ length: count }, (_, i) => ({
    id: `bench-${i}`, type: 'job', title: i % 3 === 0 ? 'Frontend Engineer' : 'Software Engineer',
    company: `Benchmark Company ${i % 250}`, description: 'Synthetic benchmark opportunity',
    source: 'curated', sourceId: `bench-${i}`, officialUrl: `https://example.test/jobs/${i}`,
    canonicalUrlHash: `url-${i}`, contentHash: `content-${i}`,
    employmentType: 'Full-time', remoteType: 'Worldwide', eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], requiredSkills: skills[i % skills.length], preferredSkills: ['Communication'],
    experienceRequirement: '4-6', qualityScore: 80, status: 'active', isActive: true,
    postedAt: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
    lastVerifiedAt: '2026-11-01T00:00:00.000Z',
  } as unknown as CanonicalOpportunity));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function main() {
  console.log(JSON.stringify({ benchmark: 'main-feed-matcher', iterations, sizes, node: process.version }));
  for (const size of sizes) {
    const jobs = makeJobs(size);
    // Warm-up is intentionally excluded from the reported distribution.
    scoreOpportunitiesForFeed(profile, jobs);
    const samples: number[] = [];
    let resultCount = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      resultCount = scoreOpportunitiesForFeed(profile, jobs).length;
      samples.push(performance.now() - start);
    }
    const memory = process.memoryUsage();
    console.log(JSON.stringify({
      rows: size, resultCount, samplesMs: samples.map((v) => Math.round(v * 100) / 100),
      p50Ms: Math.round(percentile(samples, 0.50) * 100) / 100,
      p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100,
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024 * 100) / 100,
      rssMb: Math.round(memory.rss / 1024 / 1024 * 100) / 100,
    }));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
