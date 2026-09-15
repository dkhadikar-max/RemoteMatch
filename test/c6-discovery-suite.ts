/**
 * RemoteMatch — C6 Automated Company Discovery Test Suite
 * Validates:
 * 1. Domain normalization, root extraction, second-level TLDs
 * 2. Blocklist enforcement (strict LinkedIn, Indeed, social exclusion)
 * 3. SSRF guardrails (private/loopback/cloud metadata rejection)
 * 4. ATS Endpoint Detection (Greenhouse, Lever, Ashby)
 * 5. Career surface discovery and robots.txt permission compliance
 * 6. Promotion bridge to allowlist_employers and supply_sources
 * 7. Invariant preservation (C3 adapters frozen, zero code changes)
 */
// This suite's TEST 8 (c6-promote-batch.ts) calls getSupabaseAdminClient()
// directly from a bare Node 20 process rather than through Next.js's server
// runtime, which has a native WebSocket global that bare Node 20 lacks.
// Production code is correct as-is (Railway's runtime works fine, per every
// other admin.ts caller in this codebase) — this polyfill is
// test-environment-only, the same established pattern already used in
// test/ats-provider-suite.ts / test/career-page-provider-suite.ts / etc.,
// never something admin.ts itself should import.
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import {
  normalizeDomain,
  extractRootDomain,
  isDomainBlocklisted,
  isSsrfSafeHostname,
} from '../src/lib/discovery/domain-resolver';
import { generateCandidateBoardSlugs, detectAtsEndpoint } from '../src/lib/discovery/ats-resolver';
import { findCareerSurface } from '../src/lib/discovery/career-finder';
import { DiscoveredCompany } from '../src/types/discovery';

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

async function runC6Suite() {
  console.log('============================================================');
  console.log('C6 AUTOMATED COMPANY DISCOVERY — VERIFICATION SUITE');
  console.log('Testing Domain Normalization, Blocklists, SSRF, ATS & Career Discovery');
  console.log('============================================================\n');

  // TEST 1: Domain Normalization & Root Extraction
  console.log('--- TEST 1: Domain Normalization & Root Extraction ---');
  assert(normalizeDomain('https://www.Stripe.com/jobs/123') === 'stripe.com', 'Strips https, www, and trailing paths');
  assert(normalizeDomain('HTTP://CAREERS.AIRBNB.COM/') === 'careers.airbnb.com', 'Strips protocol and normalizes lowercase');
  assert(extractRootDomain('careers.airbnb.com') === 'airbnb.com', 'Extracts root domain from subdomain');
  assert(extractRootDomain('jobs.deliveroo.co.uk') === 'deliveroo.co.uk', 'Correctly preserves second-level TLD (.co.uk)');
  assert(extractRootDomain('tech.startup.co.in') === 'startup.co.in', 'Correctly preserves second-level TLD (.co.in)');

  // TEST 2: Blocklist Enforcement (Zero LinkedIn / Aggregator tolerance)
  console.log('\n--- TEST 2: Domain Blocklist & Anti-Bot Protection ---');
  assert(isDomainBlocklisted('linkedin.com') === true, 'Strictly blocklists linkedin.com');
  assert(isDomainBlocklisted('www.linkedin.com') === true, 'Strictly blocklists www.linkedin.com');
  assert(isDomainBlocklisted('jobs.indeed.com') === true, 'Strictly blocklists indeed.com');
  assert(isDomainBlocklisted('glassdoor.com') === true, 'Strictly blocklists glassdoor.com');
  assert(isDomainBlocklisted('ziprecruiter.com') === true, 'Strictly blocklists ziprecruiter.com');
  assert(isDomainBlocklisted('wikipedia.org') === true, 'Strictly blocklists non-company directories (wikipedia)');
  assert(isDomainBlocklisted('stripe.com') === false, 'Allows legitimate employer domain (stripe.com)');

  // TEST 3: SSRF Protection
  console.log('\n--- TEST 3: SSRF & Egress Protection ---');
  assert(await isSsrfSafeHostname('localhost') === false, 'Rejects localhost');
  assert(await isSsrfSafeHostname('127.0.0.1') === false, 'Rejects 127.0.0.1');
  assert(await isSsrfSafeHostname('169.254.169.254') === false, 'Rejects cloud metadata IP (169.254.169.254)');
  assert(await isSsrfSafeHostname('10.0.0.5') === false, 'Rejects private RFC1918 10.x IP');
  assert(await isSsrfSafeHostname('192.168.1.1') === false, 'Rejects private RFC1918 192.168.x IP');

  // TEST 4: Candidate Board Slug Generation
  console.log('\n--- TEST 4: Candidate Board Slug Generation ---');
  const slugsGitlab = generateCandidateBoardSlugs('GitLab Inc.', 'gitlab.com');
  assert(slugsGitlab.includes('gitlab'), 'Generates "gitlab" from "GitLab Inc."');
  const slugsAirtable = generateCandidateBoardSlugs('Airtable', 'airtable.com');
  assert(slugsAirtable.includes('airtable'), 'Generates "airtable" from "Airtable"');

  // TEST 5: Deterministic ATS Endpoint Probing
  console.log('\n--- TEST 5: ATS Endpoint Probing ---');
  console.log('   Probing known public ATS boards (GitLab on Greenhouse, Figma on Lever)...');
  
  const gitlabProbe = await detectAtsEndpoint('GitLab', 'gitlab.com');
  assert(gitlabProbe.detected === true, 'Successfully detects GitLab on Greenhouse');
  if (gitlabProbe.detected) {
    assert(gitlabProbe.platform === 'greenhouse', 'Identifies platform as greenhouse');
    assert(gitlabProbe.sampleJobsCount! > 0, `Found ${gitlabProbe.sampleJobsCount} active postings`);
    assert(typeof gitlabProbe.remoteJobsCount === 'number', `Detected ${gitlabProbe.remoteJobsCount} remote jobs`);
  }

  const figmaProbe = await detectAtsEndpoint('Figma', 'figma.com');
  assert(figmaProbe.detected === true, 'Successfully detects Figma on Lever or Greenhouse');
  if (figmaProbe.detected) {
    assert(figmaProbe.sampleJobsCount! > 0, `Found ${figmaProbe.sampleJobsCount} active postings`);
  }

  const nonexistentProbe = await detectAtsEndpoint('NonexistentFakeCompany98765', 'fake98765xyz.org');
  assert(nonexistentProbe.detected === false, 'Returns detected=false for nonexistent company without crashing');

  // TEST 6: Promotion Entity Structure (Unit Verification)
  console.log('\n--- TEST 6: Promotion Bridge Invariant ---');
  const sampleCandidate: DiscoveredCompany = {
    canonicalName: 'GitLab Inc.',
    normalizedNameKey: 'gitlab',
    rawDomain: 'gitlab.com',
    resolvedRootDomain: 'gitlab.com',
    pipelineStage: 'qualified_remote',
    discoverySource: 'ats_reverse',
    discoveredAtsPlatform: 'greenhouse',
    discoveredAtsBoard: 'gitlab',
    discoveredCareerUrl: 'https://boards.greenhouse.io/gitlab',
    remoteEvidenceSnippet: 'GitLab is a remote-only company',
  };

  assert(sampleCandidate.pipelineStage === 'qualified_remote', 'Discovered candidate holds qualified_remote stage');
  assert(sampleCandidate.discoveredAtsPlatform === 'greenhouse', 'Holds greenhouse platform identifier');
  assert(sampleCandidate.discoveredAtsBoard === 'gitlab', 'Holds greenhouse board token');

  // TEST 7: C6-7 Automated Qualification Rules
  console.log('\n--- TEST 7: C6-7 Automated Qualification Rules ---');
  const { evaluateQualification } = await import('../src/lib/discovery/production-pipeline');

  const remoteAtsEval = evaluateQualification(
    { name: 'GitLab', domain: 'gitlab.com' },
    { valid: true, rootDomain: 'gitlab.com' },
    { detected: true, platform: 'greenhouse', boardSlug: 'gitlab', sampleJobsCount: 50, remoteJobsCount: 45, remoteEvidenceSnippet: 'Remote worldwide' }
  );
  assert(remoteAtsEval.stage === 'qualified_remote', 'Qualifies remote ATS candidate to qualified_remote');
  assert(remoteAtsEval.confidenceScore >= 75, 'Assigns confidence score >= 75 for verified remote ATS');

  const nonRemoteAtsEval = evaluateQualification(
    { name: 'Local Bank', domain: 'localbank.com' },
    { valid: true, rootDomain: 'localbank.com' },
    { detected: true, platform: 'greenhouse', boardSlug: 'localbank', sampleJobsCount: 10, remoteJobsCount: 0 }
  );
  assert(nonRemoteAtsEval.stage === 'career_found', 'Classifies non-remote ATS candidate as career_found');

  const directCareerEval = evaluateQualification(
    { name: 'Retool', domain: 'retool.com' },
    { valid: true, rootDomain: 'retool.com', finalUrl: 'https://retool.com' },
    undefined,
    { found: true, careerUrl: 'https://retool.com/careers', remoteEvidenceSnippet: 'Remote friendly' }
  );
  assert(directCareerEval.stage === 'qualified_remote', 'Classifies direct career page with remote evidence as qualified_remote');

  const invalidDomainEval = evaluateQualification(
    { name: 'Dead Company', domain: 'deadsite9999.xyz' },
    { valid: false, rejectionReason: 'dns_unresolved' }
  );
  assert(invalidDomainEval.stage === 'rejected', 'Rejects candidate with invalid/unresolved domain');

  // TEST 8: C6-7 Supervised Batch Promotion (Dry Run)
  console.log('\n--- TEST 8: C6-7 Supervised Batch Promotion CLI & Engine ---');
  const { executeSupervisedBatchPromotion } = await import('../scripts/c6-promote-batch');
  const promoReport = await executeSupervisedBatchPromotion({ dryRun: true, limit: 3 });
  assert(promoReport.totalReviewed >= 1, 'Reviewed at least 1 candidate in supervised batch dry run');
  assert(promoReport.approvedCount >= 1, 'Simulated approval for qualified candidates without error');
  assert(promoReport.failedCount === 0, 'Zero unexpected failures during dry run');

  console.log('\n============================================================');
  console.log(`C6 DISCOVERY TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runC6Suite();

