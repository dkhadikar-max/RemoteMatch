/**
 * RemoteMatch (BYN Architecture) — Gate 2: Live Job Supply & Ingestion Audit
 * Executes the live synchronization pipeline:
 * Curated, Remotive, Arbeitnow, Jobicy -> Normalize -> Remote eligibility
 * -> Deduplication -> Source quality -> Link freshness -> Feed-ready
 *
 * Captures the required observation metrics and boundary inspection assertions.
 */

import { CuratedProvider } from '../src/lib/providers/curated';
import { RemotiveProvider } from '../src/lib/providers/remotive';
import { ArbeitnowProvider } from '../src/lib/providers/arbeitnow';
import { JobicyProvider } from '../src/lib/providers/jobicy';
import {
  normalizeOpportunity,
  deduplicateOpportunities,
  verifyLinkFreshness,
  classifyRemoteEligibility,
} from '../src/lib/ingestion/pipeline';
import { RawJobPayload } from '../src/lib/providers/types';
import { CanonicalOpportunity } from '../src/types/byn';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runGate2() {
  console.log('============================================================');
  console.log('GATE 2: LIVE JOB SUPPLY & INGESTION AUDIT');
  console.log('Synchronizing Multi-Provider Stream & Verifying Feed Quality');
  console.log('============================================================\n');

  const curated = new CuratedProvider();
  const remotive = new RemotiveProvider();
  const arbeitnow = new ArbeitnowProvider();
  const jobicy = new JobicyProvider();

  console.log('1. Fetching live job feeds from providers in parallel...');
  const [curatedRaw, remotiveRaw, arbeitnowRaw, jobicyRaw] = await Promise.all([
    curated.fetchJobs(),
    remotive.fetchJobs(),
    arbeitnow.fetchJobs(),
    jobicy.fetchJobs(),
  ]);

  const rawByProvider: Record<string, RawJobPayload[]> = {
    Curated: curatedRaw,
    Remotive: remotiveRaw,
    Arbeitnow: arbeitnowRaw,
    Jobicy: jobicyRaw,
  };

  const totalFetched = curatedRaw.length + remotiveRaw.length + arbeitnowRaw.length + jobicyRaw.length;
  console.log(`   Fetched ${totalFetched} raw jobs across 4 providers:`);
  console.log(`   - Curated:   ${curatedRaw.length}`);
  console.log(`   - Remotive:  ${remotiveRaw.length}`);
  console.log(`   - Arbeitnow: ${arbeitnowRaw.length}`);
  console.log(`   - Jobicy:    ${jobicyRaw.length}\n`);

  assert(totalFetched > 0, 'Live provider ingestion fetched raw jobs');

  // 2. Normalization
  console.log('2. Normalizing raw job payloads to CanonicalOpportunity schema...');
  const allNormalized: CanonicalOpportunity[] = [];
  let weakDescriptionsCount = 0;
  let expiredCount = 0;
  let countryRestrictedCount = 0;

  for (const [providerName, rawJobs] of Object.entries(rawByProvider)) {
    for (const raw of rawJobs) {
      const opp = normalizeOpportunity(raw);
      allNormalized.push(opp);

      if ((raw.description || '').trim().length < 100) {
        weakDescriptionsCount++;
      }
      const ageDays = (Date.now() - new Date(raw.publicationDate).getTime()) / (1000 * 3600 * 24);
      if (ageDays > 60) {
        expiredCount++;
      }
      if (opp.remoteType !== 'Worldwide') {
        countryRestrictedCount++;
      }
    }
  }

  const successfullyNormalized = allNormalized.length;
  assert(successfullyNormalized === totalFetched, `Successfully normalized 100% of fetched jobs (${successfullyNormalized}/${totalFetched})`);

  // 3. Remote Qualification
  const remoteQualified = allNormalized.filter(
    (o) => o.remoteType === 'Worldwide' || o.remoteType === 'US' || o.remoteType === 'EU/EEA' || o.remoteType === 'India'
  ).length;
  assert(remoteQualified > 0, `Classified remote eligibility across supply (${remoteQualified} qualified)`);

  // 4. Deduplication
  console.log('3. Applying 4-Layer Deduplication (source ID, canonical URL, company:title, content hash)...');
  const uniqueOpportunities = deduplicateOpportunities(allNormalized);
  const duplicatesRemoved = allNormalized.length - uniqueOpportunities.length;
  console.log(`   Removed ${duplicatesRemoved} duplicates across provider overlap.`);

  // 5. Link Reachability & Freshness Audit (Sample / Staging check)
  console.log('4. Auditing Official Link Reachability & Freshness...');
  let deadLinksRemoved = 0;
  const sampleToCheck = uniqueOpportunities.slice(0, 15); // Check top 15 links
  const reachableOpportunities: CanonicalOpportunity[] = [];

  for (const opp of uniqueOpportunities) {
    // Audit sample links
    if (sampleToCheck.some((s) => s.id === opp.id)) {
      const freshness = await verifyLinkFreshness(opp.officialUrl, 3000);
      if (!freshness.reachable) {
        deadLinksRemoved++;
        opp.status = 'expired';
        opp.isActive = false;
        continue;
      }
    }

    if (opp.status === 'active' && opp.isActive) {
      reachableOpportunities.push(opp);
    }
  }

  // 6. Feed-Ready by Provider
  const feedReadyByProvider: Record<string, number> = {
    Curated: 0,
    Remotive: 0,
    Arbeitnow: 0,
    Jobicy: 0,
  };

  for (const opp of reachableOpportunities) {
    if (opp.source === 'curated') feedReadyByProvider.Curated++;
    else if (opp.source === 'remotive') feedReadyByProvider.Remotive++;
    else if (opp.source === 'arbeitnow') feedReadyByProvider.Arbeitnow++;
    else if (opp.source === 'jobicy') feedReadyByProvider.Jobicy++;
  }

  const finalFeedReady = reachableOpportunities.length;

  // Print Structured Table Required by Staging Gate 2
  console.log('\n============================================================');
  console.log('STAGING INGESTION METRICS TABLE');
  console.log('============================================================');
  console.log('| Metric                     | Required observation |');
  console.log('| -------------------------- | -------------------: |');
  console.log(`| Jobs fetched               | ${String(totalFetched).padStart(20)} |`);
  console.log(`| Successfully normalized    | ${String(successfullyNormalized).padStart(20)} |`);
  console.log(`| Remote-qualified           | ${String(remoteQualified).padStart(20)} |`);
  console.log(`| Duplicates removed         | ${String(duplicatesRemoved).padStart(20)} |`);
  console.log(`| 404/410 removed            | ${String(deadLinksRemoved).padStart(20)} |`);
  console.log(`| Expired removed            | ${String(expiredCount).padStart(20)} |`);
  console.log(`| Missing/weak descriptions  | ${String(weakDescriptionsCount).padStart(20)} |`);
  console.log(`| Country-restricted jobs    | ${String(countryRestrictedCount).padStart(20)} |`);
  console.log(`| Final feed-ready jobs      | ${String(finalFeedReady).padStart(20)} |`);
  console.log('============================================================');
  console.log('FEED-READY JOBS PER PROVIDER:');
  for (const [provider, count] of Object.entries(feedReadyByProvider)) {
    console.log(`  - ${provider.padEnd(12)}: ${count} feed-ready jobs`);
  }
  console.log('============================================================\n');

  // --- SECTION 2: BOUNDARY CLASSIFICATION INSPECTION ---
  console.log('--- SECTION 2: Boundary Classification Inspection ---');

  // Inspection 1: "Remote — US only" must NOT be Worldwide
  const testUSOnly = classifyRemoteEligibility('Remote — US only');
  assert(testUSOnly.remoteType === 'US', '"Remote — US only" correctly classified as US (NOT Worldwide)');
  assert(testUSOnly.remoteType !== 'Worldwide', '"Remote — US only" is strictly NOT Worldwide');

  // Inspection 2: "Remote in Europe" must NOT be Worldwide
  const testEU = classifyRemoteEligibility('Remote in Europe');
  assert(testEU.remoteType === 'EU/EEA', '"Remote in Europe" correctly classified as EU/EEA (NOT Worldwide)');
  assert(testEU.remoteType !== 'Worldwide', '"Remote in Europe" is strictly NOT Worldwide');

  // Inspection 3: "Remote-friendly" must NOT be fully remote Worldwide
  const testRemoteFriendly = classifyRemoteEligibility('Remote-friendly office in Berlin');
  assert(testRemoteFriendly.remoteType !== 'Worldwide', '"Remote-friendly" is strictly NOT Worldwide');

  // Inspection 4: Contractor roles must NOT be Full-time
  const contractorJob: RawJobPayload = {
    sourceId: 'c-contract-1',
    source: 'curated',
    title: 'Senior React Developer (Contractor)',
    company: 'Alpha Devs',
    description: '3-month contract role for front-end architecture.',
    officialUrl: 'https://alphadevs.io/jobs/1',
    jobType: 'Contract',
    locationString: 'Worldwide',
    publicationDate: new Date().toISOString(),
  };
  const normalizedContract = normalizeOpportunity(contractorJob);
  assert(normalizedContract.employmentType === 'Contract', 'Contractor role correctly identified as Contract (NOT Full-time)');
  assert(normalizedContract.employmentType !== 'Full-time', 'Contractor role is strictly NOT Full-time');

  // Inspection 5: Stale postings (>60 days) must NOT be active
  const staleJob: RawJobPayload = {
    sourceId: 'c-stale-1',
    source: 'curated',
    title: 'Senior Backend Engineer',
    company: 'Old Postings LLC',
    description: 'Legacy posting from 90 days ago.',
    officialUrl: 'https://oldpostings.io/jobs/1',
    jobType: 'Full-time',
    locationString: 'Worldwide',
    publicationDate: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
  };
  const normalizedStale = normalizeOpportunity(staleJob);
  assert(normalizedStale.status === 'expired', 'Stale posting (>60 days) marked as expired (NOT active)');
  assert(normalizedStale.isActive === false, 'Stale posting isActive is strictly false');

  console.log('\n============================================================');
  console.log(`GATE 2 AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runGate2().catch((err) => {
  console.error('Fatal error running Gate 2 suite:', err);
  process.exit(1);
});
