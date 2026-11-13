/**
 * Resume Intelligence — Workstream 1: OpenAI adapter
 * (docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md §4 step 1).
 *
 * Extracted from resume-intelligence-service.ts's callModel() — SAME model, SAME
 * reasoning_effort, SAME prompt-building contract, SAME request shape. The only behavior
 * change is the one gap §1 of the plan found real (not hypothetical): no timeout existed
 * anywhere in src/lib/ai/*.ts before this file. `timeoutMs` is now enforced via AbortController,
 * surfaced to the caller as `{ kind: 'timeout' }` — a bounded failure, not an indefinite hang.
 *
 * Accounting (spend-ledger reserve/consume/refund) and persistence stay in
 * resume-intelligence-service.ts — this adapter's job is ONLY the provider call itself,
 * matching the AiProviderAdapter interface's scope (see providers/types.ts).
 */
import { APIUserAbortError } from 'openai';
import { getOpenAiClient, OPENAI_MODEL_ID, OPENAI_REASONING_EFFORT } from '../openai-config';
import type { AiProviderAdapter, ModelCallParams, ModelCallOutcome, ModelCallFailureKind } from './types';

function classifyOpenAiError(err: unknown): ModelCallFailureKind {
  // REAL FINDING (2026-10-30 failure-path audit, confirmed against node_modules/openai/core/
  // error.js, not assumed): the SDK throws its own APIUserAbortError on an aborted request, a
  // subclass of APIError whose `.name` is NEVER set to the DOM's 'AbortError' — a naive
  // `err.name === 'AbortError'` check (the first version of this function) would silently never
  // match and fall through to 'other'. Functionally harmless (both routes still return
  // ok:false, still get consumed not refunded, see resume-intelligence-service.ts) but it
  // would have reported every real timeout as 'other' instead of 'timeout' in ai_call_events,
  // undercounting a metric this workstream exists partly to make visible.
  if (err instanceof APIUserAbortError) return 'timeout';
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status && status >= 500) return 'service_unavailable';
  return 'other';
}

export class OpenAiAdapter implements AiProviderAdapter {
  readonly providerId = 'openai' as const;
  readonly modelId = OPENAI_MODEL_ID;

  async call(params: ModelCallParams): Promise<ModelCallOutcome> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { ok: false, failure: { kind: 'auth_error', message: 'OPENAI_API_KEY is not set.' } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const client = getOpenAiClient();
      const completion = await client.chat.completions.create(
        {
          model: OPENAI_MODEL_ID,
          reasoning_effort: OPENAI_REASONING_EFFORT,
          response_format: { type: params.responseFormat },
          max_completion_tokens: params.maxCompletionTokens,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
        },
        { signal: controller.signal }
      );

      const usage = completion.usage;
      const rawContent = completion.choices[0]?.message?.content ?? null;
      const finishReason = completion.choices[0]?.finish_reason ?? 'unknown';

      return {
        ok: true,
        result: {
          rawContent,
          finishReason,
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          model: OPENAI_MODEL_ID,
          reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
        },
      };
    } catch (err) {
      return { ok: false, failure: { kind: classifyOpenAiError(err), status: (err as { status?: number })?.status, message: err instanceof Error ? err.message : String(err) } };
    } finally {
      clearTimeout(timer);
    }
  }
}
