/**
 * Resume Intelligence — Workstream 1: provider registry
 * (docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md §3.3 / §4 step 3).
 *
 * Model/provider selection, independent of resume-intelligence-service.ts's orchestration
 * logic. Today this always resolves to OpenAI — RESUME_INTELLIGENCE_PROVIDER is read for
 * forward-compatibility only; no other case is wired in, and none should be added without its
 * own separate authorization (a second live provider for this feature is explicitly NOT part
 * of this workstream — see the plan doc §5).
 */
import type { AiProviderAdapter, UsageLedger } from './types';
import { OpenAiAdapter } from './openai-adapter';
import { OpenAiLedger } from './openai-ledger';

export function getResumeIntelligenceProvider(): AiProviderAdapter {
  const id = process.env.RESUME_INTELLIGENCE_PROVIDER || 'openai';
  switch (id) {
    case 'openai':
      return new OpenAiAdapter();
    default:
      throw new Error(`Unknown RESUME_INTELLIGENCE_PROVIDER: ${id} (only 'openai' is wired in — see docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md)`);
  }
}

export function getResumeIntelligenceLedger(): UsageLedger {
  const id = process.env.RESUME_INTELLIGENCE_PROVIDER || 'openai';
  switch (id) {
    case 'openai':
      return new OpenAiLedger();
    default:
      throw new Error(`Unknown RESUME_INTELLIGENCE_PROVIDER: ${id} (only 'openai' is wired in — see docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md)`);
  }
}
