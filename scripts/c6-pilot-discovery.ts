/**
 * RemoteMatch — C6 Pilot Discovery Runner (100 Companies)
 *
 * Executes candidate discovery across 100 remote-first tech/engineering companies:
 * 1. Domain resolution & SSRF check
 * 2. ATS endpoint detection (Greenhouse, Lever, Ashby)
 * 3. Career surface & robots.txt permission probe
 * 4. Remote evidence qualification
 * 5. Supervised promotion into allowlist_employers
 */

import { resolveOfficialDomain, isDomainBlocklisted } from '../src/lib/discovery/domain-resolver';
import { detectAtsEndpoint } from '../src/lib/discovery/ats-resolver';
import { findCareerSurface } from '../src/lib/discovery/career-finder';
import { promoteCompanyToAllowlist } from '../src/lib/discovery/supervised-promotion';
import { DiscoveredCompany } from '../src/types/discovery';

export const PILOT_COHORT_100 = [
  { name: 'GitLab', domain: 'gitlab.com', industry: 'developer_tools' },
  { name: 'Automattic', domain: 'automattic.com', industry: 'software' },
  { name: 'DuckDuckGo', domain: 'duckduckgo.com', industry: 'search_privacy' },
  { name: 'Zapier', domain: 'zapier.com', industry: 'automation' },
  { name: 'Buffer', domain: 'buffer.com', industry: 'marketing' },
  { name: 'Ghost', domain: 'ghost.org', industry: 'publishing' },
  { name: 'Basecamp', domain: 'basecamp.com', industry: 'collaboration' },
  { name: 'Doist', domain: 'doist.com', industry: 'productivity' },
  { name: 'Hotjar', domain: 'hotjar.com', industry: 'analytics' },
  { name: 'Grafana Labs', domain: 'grafana.com', industry: 'observability' },
  { name: 'Elastic', domain: 'elastic.co', industry: 'search_data' },
  { name: 'HashiCorp', domain: 'hashicorp.com', industry: 'infrastructure' },
  { name: 'Canonical', domain: 'canonical.com', industry: 'os_open_source' },
  { name: 'Docker', domain: 'docker.com', industry: 'containers' },
  { name: 'Vercel', domain: 'vercel.com', industry: 'cloud_hosting' },
  { name: 'Supabase', domain: 'supabase.com', industry: 'developer_tools' },
  { name: 'Netlify', domain: 'netlify.com', industry: 'cloud_hosting' },
  { name: 'Fly.io', domain: 'fly.io', industry: 'infrastructure' },
  { name: 'Postman', domain: 'postman.com', industry: 'api_tools' },
  { name: 'Sourcegraph', domain: 'sourcegraph.com', industry: 'code_intelligence' },
  { name: 'Sentry', domain: 'sentry.io', industry: 'error_tracking' },
  { name: 'Prisma', domain: 'prisma.io', industry: 'database_orm' },
  { name: 'Retool', domain: 'retool.com', industry: 'internal_tools' },
  { name: 'Webflow', domain: 'webflow.com', industry: 'web_design' },
  { name: 'Loom', domain: 'loom.com', industry: 'video_communication' },
  { name: 'Figma', domain: 'figma.com', industry: 'design' },
  { name: 'Notion', domain: 'notion.so', industry: 'productivity' },
  { name: 'Miro', domain: 'miro.com', industry: 'visual_collaboration' },
  { name: 'ClickUp', domain: 'clickup.com', industry: 'project_management' },
  { name: 'Linear', domain: 'linear.app', industry: 'issue_tracking' },
  { name: 'Raycast', domain: 'raycast.com', industry: 'productivity_mac' },
  { name: 'PlanetScale', domain: 'planetscale.com', industry: 'database' },
  { name: 'Neon', domain: 'neon.tech', industry: 'serverless_postgres' },
  { name: 'Railway', domain: 'railway.app', industry: 'cloud_platform' },
  { name: 'Render', domain: 'render.com', industry: 'cloud_hosting' },
  { name: 'Pulumi', domain: 'pulumi.com', industry: 'iac' },
  { name: 'Temporal', domain: 'temporal.io', industry: 'orchestration' },
  { name: 'Tailscale', domain: 'tailscale.com', industry: 'vpn_networking' },
  { name: '1Password', domain: '1password.com', industry: 'security' },
  { name: 'Bitwarden', domain: 'bitwarden.com', industry: 'security' },
  { name: 'Brave', domain: 'brave.com', industry: 'browser_privacy' },
  { name: 'Mozilla', domain: 'mozilla.org', industry: 'open_web' },
  { name: 'Wikimedia Foundation', domain: 'wikimedia.org', industry: 'knowledge' },
  { name: 'Red Hat', domain: 'redhat.com', industry: 'open_source' },
  { name: 'SUSE', domain: 'suse.com', industry: 'linux_enterprise' },
  { name: 'Datadog', domain: 'datadoghq.com', industry: 'observability' },
  { name: 'Dynatrace', domain: 'dynatrace.com', industry: 'monitoring' },
  { name: 'New Relic', domain: 'newrelic.com', industry: 'observability' },
  { name: 'MongoDB', domain: 'mongodb.com', industry: 'database' },
  { name: 'Cockroach Labs', domain: 'cockroachlabs.com', industry: 'distributed_sql' },
  { name: 'Confluent', domain: 'confluent.io', industry: 'event_streaming' },
  { name: 'dbt Labs', domain: 'getdbt.com', industry: 'analytics_engineering' },
  { name: 'Starburst', domain: 'starburst.io', industry: 'data_lake' },
  { name: 'Fivetran', domain: 'fivetran.com', industry: 'data_integration' },
  { name: 'Snowflake', domain: 'snowflake.com', industry: 'data_warehouse' },
  { name: 'Databricks', domain: 'databricks.com', industry: 'data_ai' },
  { name: 'ClickHouse', domain: 'clickhouse.com', industry: 'olap_database' },
  { name: 'Meilisearch', domain: 'meilisearch.com', industry: 'search_engine' },
  { name: 'Algolia', domain: 'algolia.com', industry: 'search_api' },
  { name: 'Pinecone', domain: 'pinecone.io', industry: 'vector_database' },
  { name: 'Weaviate', domain: 'weaviate.io', industry: 'vector_search' },
  { name: 'Qdrant', domain: 'qdrant.tech', industry: 'vector_engine' },
  { name: 'Chroma', domain: 'trychroma.com', industry: 'ai_database' },
  { name: 'OpenAI', domain: 'openai.com', industry: 'ai_research' },
  { name: 'Anthropic', domain: 'anthropic.com', industry: 'ai_safety' },
  { name: 'Hugging Face', domain: 'huggingface.co', industry: 'ai_community' },
  { name: 'Cohere', domain: 'cohere.com', industry: 'nlp_ai' },
  { name: 'Replicate', domain: 'replicate.com', industry: 'ai_cloud' },
  { name: 'RunPod', domain: 'runpod.io', industry: 'gpu_cloud' },
  { name: 'Scale AI', domain: 'scale.com', industry: 'data_annotation' },
  { name: 'Weights & Biases', domain: 'wandb.ai', industry: 'mlops' },
  { name: 'Modal', domain: 'modal.com', industry: 'cloud_compute' },
  { name: 'Anyscale', domain: 'anyscale.com', industry: 'distributed_compute' },
  { name: 'Together AI', domain: 'together.ai', industry: 'cloud_ai' },
  { name: 'Mistral AI', domain: 'mistral.ai', industry: 'open_models' },
  { name: 'ElevenLabs', domain: 'elevenlabs.io', industry: 'voice_ai' },
  { name: 'AssemblyAI', domain: 'assemblyai.com', industry: 'speech_ai' },
  { name: 'Deepgram', domain: 'deepgram.com', industry: 'audio_ai' },
  { name: 'Resend', domain: 'resend.com', industry: 'email_api' },
  { name: 'Loops', domain: 'loops.so', industry: 'email_marketing' },
  { name: 'Plaid', domain: 'plaid.com', industry: 'fintech_api' },
  { name: 'Brex', domain: 'brex.com', industry: 'corporate_finance' },
  { name: 'Ramp', domain: 'ramp.com', industry: 'spend_management' },
  { name: 'Mercury', domain: 'mercury.com', industry: 'banking_tech' },
  { name: 'Stripe', domain: 'stripe.com', industry: 'payments' },
  { name: 'Adyen', domain: 'adyen.com', industry: 'global_payments' },
  { name: 'Wise', domain: 'wise.com', industry: 'currency_exchange' },
  { name: 'Revolut', domain: 'revolut.com', industry: 'financial_app' },
  { name: 'Monzo', domain: 'monzo.com', industry: 'digital_banking' },
  { name: 'N26', domain: 'n26.com', industry: 'mobile_banking' },
  { name: 'Remote', domain: 'remote.com', industry: 'global_hr' },
  { name: 'Deel', domain: 'deel.com', industry: 'payroll_compliance' },
  { name: 'Oyster', domain: 'oysterhr.com', industry: 'distributed_hr' },
  { name: 'Papaya Global', domain: 'papayaglobal.com', industry: 'workforce_management' },
  { name: 'Gusto', domain: 'gusto.com', industry: 'payroll_benefits' },
  { name: 'Chainlink Labs', domain: 'chain.link', industry: 'web3_oracles' },
  { name: 'Consensys', domain: 'consensys.io', industry: 'ethereum_software' },
  { name: 'Kraken', domain: 'kraken.com', industry: 'crypto_exchange' },
  { name: 'Coinbase', domain: 'coinbase.com', industry: 'crypto_platform' },
  { name: 'Bitfinex', domain: 'bitfinex.com', industry: 'digital_assets' },
];

export interface PilotRunResults {
  totalCandidates: number;
  officialWebsitesVerified: number;
  atsDetectedCount: number;
  careerPagesFoundCount: number;
  qualifiedRemoteCount: number;
  atsBreakdown: {
    greenhouse: number;
    lever: number;
    ashby: number;
    direct_career_page: number;
    none: number;
  };
  qualifiedCandidates: DiscoveredCompany[];
  promotedCount?: number;
}

export async function runPilotDiscovery(shouldPromote = false): Promise<PilotRunResults> {
  console.log('============================================================');
  console.log(`C6 PILOT DISCOVERY: Running across ${PILOT_COHORT_100.length} Candidate Companies`);
  console.log('Zero LinkedIn | Zero Anti-Bot Evasion | Public Endpoints Only');
  console.log('============================================================\n');

  let websitesVerified = 0;
  let atsDetected = 0;
  let careerPagesFound = 0;
  let qualifiedRemote = 0;

  const atsBreakdown = {
    greenhouse: 0,
    lever: 0,
    ashby: 0,
    direct_career_page: 0,
    none: 0,
  };

  const qualifiedCandidates: DiscoveredCompany[] = [];

  // Run with controlled concurrency (5 workers)
  const batchSize = 5;
  for (let i = 0; i < PILOT_COHORT_100.length; i += batchSize) {
    const chunk = PILOT_COHORT_100.slice(i, i + batchSize);
    console.log(`Processing cohort chunk ${i + 1}..${Math.min(i + batchSize, PILOT_COHORT_100.length)} of ${PILOT_COHORT_100.length}...`);

    await Promise.allSettled(
      chunk.map(async (candidate) => {
        try {
          if (isDomainBlocklisted(candidate.domain)) {
            console.log(`  [Blocklist] ${candidate.name} (${candidate.domain}) is blocklisted.`);
            return;
          }

          // Step 1: Probe ATS endpoints directly (Greenhouse, Lever, Ashby)
          const atsProbe = await detectAtsEndpoint(candidate.name, candidate.domain);
          if (atsProbe.detected && atsProbe.platform) {
            websitesVerified++;
            atsDetected++;
            atsBreakdown[atsProbe.platform]++;

            const isRemoteQualified = (atsProbe.remoteJobsCount || 0) > 0 || (atsProbe.sampleJobsCount || 0) > 0;
            if (isRemoteQualified) {
              qualifiedRemote++;
            }

            const discovered: DiscoveredCompany = {
              canonicalName: candidate.name,
              normalizedNameKey: candidate.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
              rawDomain: candidate.domain,
              resolvedRootDomain: candidate.domain,
              industry: candidate.industry,
              discoverySource: 'pilot_cohort',
              pipelineStage: isRemoteQualified ? 'qualified_remote' : 'career_found',
              discoveredCareerUrl: atsProbe.endpointUrl,
              discoveredAtsPlatform: atsProbe.platform,
              discoveredAtsBoard: atsProbe.boardSlug,
              remoteEvidenceSnippet: atsProbe.remoteEvidenceSnippet,
              confidenceScore: 95,
            };

            if (isRemoteQualified) {
              qualifiedCandidates.push(discovered);
            }
            console.log(`  ✓ [ATS] ${candidate.name} -> ${atsProbe.platform.toUpperCase()} (${atsProbe.boardSlug}) | Active: ${atsProbe.sampleJobsCount}, Remote: ${atsProbe.remoteJobsCount}`);
            return;
          }

          // Step 2: Website resolution & career-page discovery
          const domainRes = await resolveOfficialDomain(candidate.domain);
          if (!domainRes.valid || !domainRes.finalUrl) {
            console.log(`  ✗ [Domain] ${candidate.name} (${candidate.domain}) resolution failed: ${domainRes.rejectionReason}`);
            atsBreakdown.none++;
            return;
          }

          websitesVerified++;
          const careerRes = await findCareerSurface(domainRes.finalUrl, candidate.name);

          if (careerRes.found && careerRes.careerUrl) {
            careerPagesFound++;

            // Did the career surface link to an ATS?
            if (careerRes.atsResult && careerRes.atsResult.platform) {
              atsDetected++;
              atsBreakdown[careerRes.atsResult.platform]++;
              qualifiedRemote++;

              qualifiedCandidates.push({
                canonicalName: candidate.name,
                normalizedNameKey: candidate.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
                rawDomain: candidate.domain,
                resolvedRootDomain: domainRes.resolvedRootDomain,
                industry: candidate.industry,
                discoverySource: 'pilot_cohort',
                pipelineStage: 'qualified_remote',
                discoveredCareerUrl: careerRes.atsResult.endpointUrl || careerRes.careerUrl,
                discoveredAtsPlatform: careerRes.atsResult.platform,
                discoveredAtsBoard: careerRes.atsResult.boardSlug,
                remoteEvidenceSnippet: careerRes.remoteEvidenceSnippet,
                confidenceScore: 90,
              });
              console.log(`  ✓ [Career->ATS] ${candidate.name} -> ${careerRes.atsResult.platform} (${careerRes.careerUrl})`);
              return;
            }

            // Direct career page for C5
            atsBreakdown.direct_career_page++;
            const hasRemoteEvidence = Boolean(careerRes.remoteEvidenceSnippet);
            if (hasRemoteEvidence) {
              qualifiedRemote++;
            }

            qualifiedCandidates.push({
              canonicalName: candidate.name,
              normalizedNameKey: candidate.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
              rawDomain: candidate.domain,
              resolvedRootDomain: domainRes.resolvedRootDomain,
              industry: candidate.industry,
              discoverySource: 'pilot_cohort',
              pipelineStage: hasRemoteEvidence ? 'qualified_remote' : 'career_found',
              discoveredCareerUrl: careerRes.careerUrl,
              discoveredAtsPlatform: 'none',
              hasJsonLdJobs: careerRes.hasJsonLd,
              robotsPermission: careerRes.robotsAllowed ? 'allowed' : 'unknown',
              remoteEvidenceSnippet: careerRes.remoteEvidenceSnippet,
              confidenceScore: 80,
            });
            console.log(`  ✓ [Direct Career] ${candidate.name} -> ${careerRes.careerUrl} (JSON-LD: ${careerRes.hasJsonLd}, Remote: ${hasRemoteEvidence})`);
          } else {
            atsBreakdown.none++;
            console.log(`  - [No Career Surface] ${candidate.name} (${candidate.domain})`);
          }
        } catch (err) {
          console.error(`  ✗ [Error] ${candidate.name}:`, (err as Error).message);
          atsBreakdown.none++;
        }
      })
    );
  }

  console.log('\n============================================================');
  console.log('PILOT DISCOVERY RESULTS SUMMARY');
  console.log('============================================================');
  console.log(`Total Candidates Evaluated:     ${PILOT_COHORT_100.length}`);
  console.log(`Official Websites Verified:     ${websitesVerified} / ${PILOT_COHORT_100.length}`);
  console.log(`Total ATS Boards Identified:    ${atsDetected}`);
  console.log(`  - Greenhouse:                 ${atsBreakdown.greenhouse}`);
  console.log(`  - Lever:                      ${atsBreakdown.lever}`);
  console.log(`  - Ashby:                      ${atsBreakdown.ashby}`);
  console.log(`Direct Career Surfaces:         ${atsBreakdown.direct_career_page}`);
  console.log(`No Career Found / Unverified:   ${atsBreakdown.none}`);
  console.log(`Total Remote-Qualified:         ${qualifiedRemote}`);
  console.log('============================================================\n');

  let promotedCount = 0;
  if (shouldPromote) {
    console.log('--- Executing Supervised Promotion into allowlist_employers ---');
    for (const comp of qualifiedCandidates) {
      if (comp.pipelineStage === 'qualified_remote') {
        const promo = await promoteCompanyToAllowlist(comp, 'c6_pilot_supervised');
        if (promo.promoted) {
          promotedCount++;
        }
      }
    }
    console.log(`Successfully promoted ${promotedCount} verified employers to allowlist_employers!\n`);
  }

  return {
    totalCandidates: PILOT_COHORT_100.length,
    officialWebsitesVerified: websitesVerified,
    atsDetectedCount: atsDetected,
    careerPagesFoundCount: careerPagesFound,
    qualifiedRemoteCount: qualifiedRemote,
    atsBreakdown,
    qualifiedCandidates,
    promotedCount,
  };
}

if (process.argv[1]?.includes('c6-pilot-discovery')) {
  const shouldPromote = process.argv.includes('--promote');
  runPilotDiscovery(shouldPromote)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Pilot discovery failed:', err);
      process.exit(1);
    });
}
