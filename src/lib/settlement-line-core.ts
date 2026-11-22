/**
 * Pure settlement-line derivation shared by the retained legacy rebuild, the incremental
 * maintenance path and the equivalence tests. No server-only imports live here.
 *
 * Financial fields are produced by `splitSettlement` in exactly the same way as the
 * original implementation; only the surrounding metadata and linkage lookup strategy
 * differ between legacy and incremental builders.
 */

import { splitSettlement, type FeeScheduleValues } from "./fee-math.ts";

/** Bumped whenever the stored derivation shape changes. Legacy rows keep the old marker. */
export const SETTLEMENT_LINE_VERSION = "incremental-v1";

export type SettlementLineSource = {
  id: string;
  orderNumber: string | number | null;
  grossAmount: number;
  commissionAmount: number;
  refundAmount: number;
  adjustmentAmount: number;
  paidAt: Date | null;
  createdAt: Date;
  sourceUpdatedAt: Date | null;
};

export type SettlementLineOrder = {
  id: string;
  orderNumber: string | number;
};

export type SettlementLineAttempt = {
  id: string;
  orderId: string;
  createdAt?: Date;
};

export type SettlementLineFinancials = {
  settlementId: string;
  orderId: string | null;
  paymentAttemptId: string | null;
  grossPaise: number;
  commissionPaise: number;
  gatewayFeePaise: number;
  taxPaise: number;
  refundPaise: number;
  adjustmentPaise: number;
  netPaise: number;
  source: string;
  sourceAt: Date | null;
  sourceUpdatedAt: Date | null;
  expectedNetPaise: number;
  matchesAuthoritative: boolean;
};

export type SettlementLineDraft = SettlementLineFinancials & {
  businessId: string;
  feeScheduleId: string | null;
  lineVersion: string;
  rebuiltAt: Date;
};

function financialsFor(
  settlement: SettlementLineSource,
  orderId: string | null,
  paymentAttemptId: string | null,
  schedule: FeeScheduleValues | null,
): SettlementLineFinancials {
  const split = splitSettlement({
    grossPaise: settlement.grossAmount,
    authoritativeCommissionPaise: settlement.commissionAmount,
    refundPaise: settlement.refundAmount,
    adjustmentPaise: settlement.adjustmentAmount,
    schedule,
  });
  return {
    settlementId: settlement.id,
    orderId,
    paymentAttemptId,
    grossPaise: split.grossPaise,
    commissionPaise: split.commissionPaise,
    gatewayFeePaise: split.gatewayFeePaise,
    taxPaise: split.taxPaise,
    refundPaise: split.refundPaise,
    adjustmentPaise: split.adjustmentPaise,
    netPaise: split.netPaise,
    source: "marketplace",
    sourceAt: settlement.paidAt ?? settlement.createdAt,
    sourceUpdatedAt: settlement.sourceUpdatedAt,
    expectedNetPaise: split.expectedNetPaise,
    matchesAuthoritative: split.matchesAuthoritative,
  };
}

/** Verbatim financial/linkage behaviour of the original `ensureSettlementLines`. */
export function legacySettlementLineValues(input: {
  businessId: string;
  settlements: readonly SettlementLineSource[];
  orders: readonly SettlementLineOrder[];
  attempts: readonly SettlementLineAttempt[];
  schedule: FeeScheduleValues | null;
}): SettlementLineFinancials[] {
  const orderByNumber = new Map(input.orders.map((row) => [String(row.orderNumber), row.id]));
  const attemptByOrder = new Map<string, string>();
  for (const attempt of input.attempts) {
    if (!attemptByOrder.has(attempt.orderId)) attemptByOrder.set(attempt.orderId, attempt.id);
  }
  return input.settlements.map((settlement) => {
    const orderId = settlement.orderNumber === null ? null : orderByNumber.get(String(settlement.orderNumber)) ?? null;
    return financialsFor(settlement, orderId, orderId ? attemptByOrder.get(orderId) ?? null : null, input.schedule);
  });
}

/**
 * Incremental builder. It preserves the legacy first-attempt linkage for the supplied
 * input order and carries the fee-schedule/source version needed to detect stale rows.
 * The database caller supplies that input in a deterministic oldest-first order.
 */
export function buildSettlementLineDrafts(input: {
  businessId: string;
  settlements: readonly SettlementLineSource[];
  orders: readonly SettlementLineOrder[];
  attempts: readonly SettlementLineAttempt[];
  schedule: FeeScheduleValues | null;
  feeScheduleId?: string | null;
  rebuiltAt?: Date;
}): SettlementLineDraft[] {
  const orderByNumber = new Map(input.orders.map((row) => [String(row.orderNumber), row.id]));
  const attemptByOrder = new Map<string, string>();
  for (const attempt of input.attempts) {
    if (!attemptByOrder.has(attempt.orderId)) attemptByOrder.set(attempt.orderId, attempt.id);
  }
  const rebuiltAt = input.rebuiltAt ?? new Date();
  return input.settlements.map((settlement) => {
    const orderId = settlement.orderNumber === null ? null : orderByNumber.get(String(settlement.orderNumber)) ?? null;
    return {
      ...financialsFor(settlement, orderId, orderId ? attemptByOrder.get(orderId) ?? null : null, input.schedule),
      businessId: input.businessId,
      feeScheduleId: input.feeScheduleId ?? null,
      lineVersion: SETTLEMENT_LINE_VERSION,
      rebuiltAt,
    };
  });
}
