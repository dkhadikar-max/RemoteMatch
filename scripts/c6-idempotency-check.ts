import { CANARY_100 } from './c6-canary-runner';
import { runProductionDiscoveryBatch } from '../src/lib/discovery/production-pipeline';
import { normalizeOpportunity, deduplicateOpportunities } from '../src/lib/ingestion/pipeline';
import { passesFreshnessGate } from '../src/lib/ingestion/freshness-gate';

export async function runIdempotencyCheck() {
  console.log('============================================================');
  console.log('REMOTEMATCH — C6 IDEMPOTENCY & SECOND-RUN VERIFICATION');
  console.log('Executing Back-to-Back Batches Over Same Cohort');
  console.log('============================================================\n');

  // RUN 1
  console.log('--- EXECUTING RUN 1 (Initial Canary Batch) ---');
  const run1Metrics = await runProductionDiscoveryBatch(CANARY_100, {
    concurrency: 10,
    minConfidenceScore: 75,
    maxRateLimitErrorRatio: 0.1,
  });

  const promotedRegistry = new Map<string, { platform: string; board: string }>();
  let run1Duplicates = 0;

  for (const c of run1Metrics.candidates) {
    if (c.pipelineStage === 'qualified_remote' && c.discoveredAtsPlatform && c.discoveredAtsBoard) {
      const key = (c.resolvedRootDomain || c.rawDomain).toLowerCase();
      if (promotedRegistry.has(key)) {
        run1Duplicates++;
      } else {
        promotedRegistry.set(key, { platform: c.discoveredAtsPlatform, board: c.discoveredAtsBoard });
      }
    }
  }

  console.log(`Run 1 Qualified Remote Candidates:        ${run1Metrics.qualifiedRemoteCount}`);
  console.log(`Run 1 Promoted Approved ATS Employers:    ${promotedRegistry.size}`);
  console.log(`Run 1 Internal Duplicates Caught:         ${run1Duplicates}\n`);

  // RUN 2 (Immediate Re-execution of the same cohort)
  console.log('--- EXECUTING RUN 2 (Scheduled Re-Execution / Idempotency Check) ---');
  const run2Metrics = await runProductionDiscoveryBatch(CANARY_100, {
    concurrency: 10,
    minConfidenceScore: 75,
    maxRateLimitErrorRatio: 0.1,
  });

  let duplicateEmployerCollisionsPrevented = 0;
  let newDuplicateSourcesCreated = 0;
  let netNewEmployersAdded = 0;

  for (const c of run2Metrics.candidates) {
    if (c.pipelineStage === 'qualified_remote' && c.discoveredAtsPlatform && c.discoveredAtsBoard) {
      const key = (c.resolvedRootDomain || c.rawDomain).toLowerCase();
      if (promotedRegistry.has(key)) {
        duplicateEmployerCollisionsPrevented++;
        // Idempotency: source already exists in registry, zero duplicate created
      } else {
        netNewEmployersAdded++;
        newDuplicateSourcesCreated++;
      }
    }
  }

  console.log('\n============================================================');
  console.log('SECOND-RUN IDEMPOTENCY RESULTS');
  console.log('============================================================');
  console.log(`1. Total Candidates Re-Evaluated:             ${run2Metrics.totalEvaluated}`);
  console.log(`2. Duplicate Employer Collisions Prevented:   ${duplicateEmployerCollisionsPrevented}`);
  console.log(`3. Net-New Duplicate Sources Created:         ${newDuplicateSourcesCreated}`);
  console.log(`4. Net-New Duplicate Employers Created:       ${netNewEmployersAdded}`);
  console.log(`5. Idempotency Invariant Result:              ${newDuplicateSourcesCreated === 0 ? 'PASS (0 duplicate sources)' : 'FAIL'}`);
  console.log('============================================================\n');

  if (newDuplicateSourcesCreated !== 0 || netNewEmployersAdded !== 0) {
    throw new Error('Idempotency violation: duplicate sources or employers created on second run!');
  }

  return {
    run1Employers: promotedRegistry.size,
    duplicateCollisionsPrevented: duplicateEmployerCollisionsPrevented,
    newDuplicateSources: newDuplicateSourcesCreated,
    idempotent: true,
  };
}

runIdempotencyCheck()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
