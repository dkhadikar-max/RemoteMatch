/**
 * Resume Intelligence — Workstream 1: provider-independent execution architecture
 * (docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md §3).
 *
 * This interface exists so resume-intelligence-service.ts's orchestration (cache lookup,
 * pending claim, quota reservation, validation, upsert) never branches on which model provider
 * is in use. Every adapter normalizes to this shape; provider-specific quirks (reasoning_effort,
 * response_format, request shape) live entirely inside the adapter, never in the orchestrator.
 *
 * Deliberately two separate interfaces for calling vs. accounting (not merged): the real
 * production ledgers already differ in kind — OpenAI's is a dollar-cost reservation
 * (spend-ledger.ts), Gemini's (for a different feature, C5 extraction) is a request-count
 * reservation (quota-ledger.ts) with no per-call cost figure at all. Forcing both into one shape
 * would mean inventing a fake cost for Gemini or a fake request-count ceiling for OpenAI.
 */

export interface ModelCallParams {
  systemPrompt: string;
  userPrompt: string;
  maxCompletionTokens: number;
  /** Every provider in this codebase speaks JSON mode; kept as a literal (not a wider type)
   *  so a provider lacking it must get its own escape hatch here rather than silently accept
   *  something it can't honor. */
  responseFormat: 'json_object';
  timeoutMs: number;
}

export interface ModelCallResult {
  rawContent: string | null;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  /** Reasoning-token count for reasoning-class models (e.g. OpenAI's gpt-5-mini), when the
   *  provider's response exposes it. Optional/nullable so every other adapter (Gemini, Groq,
   *  OpenRouter, Vertex — none of which have a reasoning-token concept) and every existing test
   *  fixture constructing this type stay unchanged; only the OpenAI adapter populates it. */
  reasoningTokens?: number | null;
}

export type ModelCallFailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'service_unavailable'
  | 'auth_error'
  | 'model_not_found'
  | 'malformed_response'
  | 'other';

export interface ModelCallFailure {
  kind: ModelCallFailureKind;
  status?: number;
  message: string;
}

export type ModelCallOutcome =
  | { ok: true; result: ModelCallResult }
  | { ok: false; failure: ModelCallFailure };

export interface AiProviderAdapter {
  readonly providerId: 'openai' | 'gemini' | 'vertex' | 'groq';
  /** Exposed so the orchestrator can log a model identifier even on a failure path, where
   *  ModelCallResult (which also carries `model`) was never produced. */
  readonly modelId: string;
  call(params: ModelCallParams): Promise<ModelCallOutcome>;
}

/** Discriminated by `kind` so a ledger implementation only ever receives the accounting shape
 *  it actually enforces — a count-based ledger (Gemini) is never handed a dollar estimate, and
 *  a cost-based ledger (OpenAI) is never handed a request count. */
export type UsageEstimate =
  | { kind: 'cost'; promptText: string; maxCompletionTokens: number }
  | { kind: 'count' };

export type UsageActual =
  | { kind: 'cost'; promptTokens?: number; completionTokens?: number }
  | { kind: 'count' };

export interface ReservationResult {
  allowed: boolean;
  reason?: string;
  /** Opaque to the orchestrator — pass back unchanged to consume()/refund(). Each ledger
   *  implementation encodes whatever it needs (usagePeriod + reservedCostUsd for OpenAI,
   *  usageDate for Gemini) into this string/object; the orchestrator never inspects it. */
  reservationToken?: unknown;
}

export interface UsageLedger {
  reserve(feature: string, estimate: UsageEstimate): Promise<ReservationResult>;
  /** Call after ANY response from the provider — success, failure, malformed, anything that
   *  means the request actually reached it. Never call refund() after this point (the safety
   *  invariant both existing ledgers already enforce by convention; this interface makes it
   *  the orchestrator's single branch instead of a per-call-site discipline). Returns the
   *  reconciled real cost when the ledger kind tracks one (cost-based ledgers only) so callers
   *  can log it to observability without re-deriving it — a count-based ledger returns {}. */
  consume(feature: string, reservationToken: unknown, actual: UsageActual): Promise<{ actualCostUsd?: number }>;
  /** Call ONLY when the provider was never reached at all (a pre-flight error before the
   *  request left the process). */
  refund(feature: string, reservationToken: unknown): Promise<void>;
}

/** The hook a token-refreshing adapter (e.g. a future Vertex adapter) would plug into — not
 *  implemented by any adapter yet, since OpenAI/Gemini both use a static env-var API key today.
 *  See docs/resume-pr-b-vertex-technical-design-2026-10-30.md's carried-forward token-refresh
 *  debt item. */
export interface CredentialProvider {
  getAuthHeader(): Promise<{ header: string; value: string }>;
}
