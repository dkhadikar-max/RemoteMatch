/**
 * Resume Intelligence — Workstream 1: OpenAI usage ledger adapter
 * (docs/resume-pr-b-workstream1-provider-architecture-plan-2026-10-30.md §4 step 2).
 *
 * Thin wrapper around the EXISTING spend-ledger.ts functions — no changes to spend-ledger.ts
 * itself, its RPCs, or the database schema. This file only adapts the existing
 * reserve/consume/refund calls to the UsageLedger interface so resume-intelligence-service.ts
 * can call through one shape regardless of provider; OpenAI's real accounting (a dollar-cost
 * reservation, computed from estimated prompt tokens + a configured max-completion-token cap)
 * is unchanged.
 */
import { reserveOpenAiSpend, consumeOpenAiSpend, refundOpenAiSpend } from '../spend-ledger';
import type { UsageLedger, UsageEstimate, UsageActual, ReservationResult } from './types';

interface OpenAiReservationToken {
  usagePeriod: string;
  reservedCostUsd: number;
}

export class OpenAiLedger implements UsageLedger {
  async reserve(feature: string, estimate: UsageEstimate): Promise<ReservationResult> {
    if (estimate.kind !== 'cost') {
      throw new Error('OpenAiLedger.reserve() requires a cost-kind UsageEstimate');
    }
    const reservation = await reserveOpenAiSpend(feature, estimate.promptText, estimate.maxCompletionTokens);
    if (!reservation.allowed) {
      return { allowed: false, reason: reservation.reason };
    }
    const token: OpenAiReservationToken = {
      usagePeriod: reservation.usagePeriod as string,
      reservedCostUsd: reservation.reservedCostUsd as number,
    };
    return { allowed: true, reservationToken: token };
  }

  async consume(feature: string, reservationToken: unknown, actual: UsageActual): Promise<{ actualCostUsd?: number }> {
    if (actual.kind !== 'cost') {
      throw new Error('OpenAiLedger.consume() requires a cost-kind UsageActual');
    }
    const token = reservationToken as OpenAiReservationToken;
    const result = await consumeOpenAiSpend(feature, token.usagePeriod, token.reservedCostUsd, actual.promptTokens, actual.completionTokens);
    return { actualCostUsd: result.actualCostUsd };
  }

  async refund(feature: string, reservationToken: unknown): Promise<void> {
    const token = reservationToken as OpenAiReservationToken;
    await refundOpenAiSpend(feature, token.usagePeriod, token.reservedCostUsd);
  }
}
