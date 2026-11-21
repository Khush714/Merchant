/**
 * Pure order ↔ collection ↔ payout matching. It deliberately reports anomalies instead of
 * mutating money. The service layer persists each exception against an immutable run.
 */

import { settlementNetPaise, type SettlementAmounts } from "./fee-math.ts";

type SettlementWithNet = SettlementAmounts & { netPaise: number };

export type ReconciliationOrder = {
  key: string;
  id: string | null;
  totalPaise: number;
  paymentStatus: string;
  status: string;
  refundedPaise?: number;
};

export type ReconciliationAttempt = {
  key: string;
  id: string;
  status: string;
  amountPaise: number;
};

export type ReconciliationSettlement = SettlementWithNet & {
  key: string;
  id: string;
  status: string;
};

export type ReconciliationPayout = {
  id: string;
  reference: string;
  amountPaise: number;
  status: string;
  completedAt: string | null;
  allocations: { settlementId: string; amountPaise: number }[];
};

export type ReconciliationException = {
  kind: string;
  severity: "critical" | "warning" | "info";
  detail: string;
  expectedPaise: number;
  actualPaise: number;
  orderId: string | null;
  paymentAttemptId: string | null;
  settlementId: string | null;
  payoutId: string | null;
};

export type ReconciliationReport = {
  exceptions: ReconciliationException[];
  counts: Record<string, number>;
  matchedSettlements: number;
  allocatedSettlements: number;
};

const MONEY_STATUSES = new Set(["paid", "refunded", "captured", "PAID", "REFUNDED"]);

type ExceptionInput = Pick<ReconciliationException, "kind" | "severity" | "detail"> & Partial<ReconciliationException>;
function exception(input: ExceptionInput): ReconciliationException {
  return {
    kind: input.kind,
    severity: input.severity,
    detail: input.detail,
    expectedPaise: input.expectedPaise ?? 0,
    actualPaise: input.actualPaise ?? 0,
    orderId: input.orderId ?? null,
    paymentAttemptId: input.paymentAttemptId ?? null,
    settlementId: input.settlementId ?? null,
    payoutId: input.payoutId ?? null,
  };
}

/**
 * Matching keys are supplied by the service: paired outlets use the Marketplace order code,
 * unpaired outlets use the local order number. No remote API is touched here.
 */
export function classifyReconciliation(input: {
  orders: readonly ReconciliationOrder[];
  attempts: readonly ReconciliationAttempt[];
  settlements: readonly ReconciliationSettlement[];
  payouts: readonly ReconciliationPayout[];
}): ReconciliationReport {
  const exceptions: ReconciliationException[] = [];
  const orderByKey = new Map(input.orders.map((order) => [order.key, order]));
  const attemptByKey = new Map<string, ReconciliationAttempt>();
  for (const attempt of input.attempts) {
    const current = attemptByKey.get(attempt.key);
    if (!current || attempt.amountPaise > current.amountPaise) attemptByKey.set(attempt.key, attempt);
  }
  const settlementByKey = new Map(input.settlements.map((settlement) => [settlement.key, settlement]));
  const settlementById = new Map(input.settlements.map((settlement) => [settlement.id, settlement]));
  const allocated = new Set<string>();

  let matchedSettlements = 0;
  for (const order of input.orders) {
    if (!MONEY_STATUSES.has(order.paymentStatus)) continue;
    const attempt = attemptByKey.get(order.key);
    if (attempt && attempt.amountPaise !== order.totalPaise) {
      exceptions.push(exception({
        kind: "payment_amount_mismatch", severity: "critical",
        detail: `Payment attempt for order ${order.key} was ${attempt.amountPaise} paise, order total is ${order.totalPaise}.`,
        expectedPaise: order.totalPaise, actualPaise: attempt.amountPaise,
        orderId: order.id, paymentAttemptId: attempt.id,
      }));
    }
    const settlement = settlementByKey.get(order.key);
    if (!settlement) {
      exceptions.push(exception({
        kind: "missing_settlement", severity: "critical",
        detail: `Paid order ${order.key} has no matching settlement line.`,
        expectedPaise: order.totalPaise, orderId: order.id, paymentAttemptId: attempt?.id ?? null,
      }));
      continue;
    }
    matchedSettlements++;
    if (settlement.grossPaise !== order.totalPaise) {
      exceptions.push(exception({
        kind: "gross_mismatch", severity: "critical",
        detail: `Settlement gross for order ${order.key} does not match the order total.`,
        expectedPaise: order.totalPaise, actualPaise: settlement.grossPaise,
        orderId: order.id, settlementId: settlement.id,
      }));
    }
    const expectedNet = settlementNetPaise(settlement);
    if (expectedNet !== settlement.netPaise) {
      exceptions.push(exception({
        kind: "net_mismatch", severity: "critical",
        detail: `Settlement ${settlement.id} net does not equal gross minus fees, refunds and adjustments.`,
        expectedPaise: expectedNet, actualPaise: settlement.netPaise,
        orderId: order.id, settlementId: settlement.id,
      }));
    }
    if (order.paymentStatus.toLowerCase() === "refunded" && settlement.refundPaise <= 0) {
      exceptions.push(exception({
        kind: "refund_not_in_settlement", severity: "critical",
        detail: `Order ${order.key} is refunded but its settlement has no refund amount.`,
        expectedPaise: order.totalPaise, orderId: order.id, settlementId: settlement.id,
      }));
    }
  }

  for (const attempt of input.attempts) {
    if (!["paid", "refunded"].includes(attempt.status.toLowerCase())) continue;
    if (!settlementByKey.has(attempt.key)) {
      exceptions.push(exception({
        kind: "orphan_payment", severity: "warning",
        detail: `Confirmed payment ${attempt.id} has no matching settlement.`,
        actualPaise: attempt.amountPaise, paymentAttemptId: attempt.id,
      }));
    }
  }

  for (const settlement of input.settlements) {
    if (!orderByKey.has(settlement.key)) {
      exceptions.push(exception({
        kind: "orphan_settlement", severity: "warning",
        detail: `Settlement ${settlement.id} has no matching order in the current window.`,
        actualPaise: settlement.netPaise, settlementId: settlement.id,
      }));
    }
  }

  for (const payout of input.payouts) {
    const allocatedPaise = payout.allocations.reduce((sum, line) => sum + line.amountPaise, 0);
    if (allocatedPaise !== payout.amountPaise) {
      exceptions.push(exception({
        kind: "payout_allocation_mismatch", severity: "critical",
        detail: `Payout ${payout.reference} allocations total ${allocatedPaise} but the payout is ${payout.amountPaise} paise.`,
        expectedPaise: payout.amountPaise, actualPaise: allocatedPaise, payoutId: payout.id,
      }));
    }
    for (const line of payout.allocations) {
      allocated.add(line.settlementId);
      const settlement = settlementById.get(line.settlementId);
      if (settlement && line.amountPaise !== settlement.netPaise) {
        exceptions.push(exception({
          kind: "payout_line_mismatch", severity: "critical",
          detail: `Payout ${payout.reference} allocates ${line.amountPaise} to a ${settlement.netPaise} paise settlement.`,
          expectedPaise: settlement.netPaise, actualPaise: line.amountPaise,
          settlementId: settlement.id, payoutId: payout.id,
        }));
      }
    }
    if (["paid", "completed", "settled"].includes(payout.status.toLowerCase()) && !payout.completedAt) {
      exceptions.push(exception({
        kind: "payout_missing_timestamp", severity: "warning",
        detail: `Payout ${payout.reference} is marked paid without a bank confirmation timestamp.`,
        actualPaise: payout.amountPaise, payoutId: payout.id,
      }));
    }
  }

  for (const settlement of input.settlements) {
    if (!allocated.has(settlement.id)) {
      exceptions.push(exception({
        kind: "unallocated_settlement", severity: "info",
        detail: `Settlement ${settlement.id} is not linked to a recorded bank payout. Marketplace currently exposes no payout feed.`,
        actualPaise: settlement.netPaise, settlementId: settlement.id,
      }));
    }
  }

  const counts: Record<string, number> = {};
  for (const item of exceptions) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { exceptions, counts, matchedSettlements, allocatedSettlements: allocated.size };
}
