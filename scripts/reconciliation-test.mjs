import assert from "node:assert/strict";
import { classifyReconciliation } from "../src/lib/reconciliation-core.ts";

const settlement = (overrides = {}) => ({
  key: "1001", id: "set-1", grossPaise: 10_000, commissionPaise: 600, gatewayFeePaise: 0,
  taxPaise: 0, refundPaise: 0, adjustmentPaise: 0, netPaise: 9_400, status: "paid", ...overrides,
});
const order = (overrides = {}) => ({
  key: "1001", id: "ord-1", totalPaise: 10_000, paymentStatus: "paid", status: "completed", ...overrides,
});

const clean = classifyReconciliation({
  orders: [order()],
  attempts: [{ key: "1001", id: "att-1", status: "paid", amountPaise: 10_000 }],
  settlements: [settlement()],
  payouts: [{ id: "pay-1", reference: "UTR1", amountPaise: 9_400, status: "paid", completedAt: "2026-11-21T10:00:00Z", allocations: [{ settlementId: "set-1", amountPaise: 9_400 }] }],
});
assert.equal(clean.exceptions.length, 0, "a fully matched chain is clean");
assert.equal(clean.matchedSettlements, 1);
assert.equal(clean.allocatedSettlements, 1);

const broken = classifyReconciliation({
  orders: [order(), order({ key: "1002", id: "ord-2", paymentStatus: "failed" })],
  attempts: [{ key: "1001", id: "att-1", status: "paid", amountPaise: 9_900 }, { key: "1003", id: "att-3", status: "paid", amountPaise: 5_000 }],
  settlements: [settlement({ netPaise: 9_300 }), settlement({ key: "1004", id: "set-4", netPaise: 2_000 })],
  payouts: [{ id: "pay-1", reference: "UTR1", amountPaise: 8_000, status: "paid", completedAt: null, allocations: [{ settlementId: "set-1", amountPaise: 9_400 }] }],
});
const kinds = broken.exceptions.map((item) => item.kind);
for (const expected of [
  "payment_amount_mismatch", "net_mismatch", "orphan_payment", "orphan_settlement",
  "payout_allocation_mismatch", "payout_line_mismatch", "payout_missing_timestamp", "unallocated_settlement",
]) assert.ok(kinds.includes(expected), `${expected} must be reported`);
assert.equal(broken.counts.net_mismatch, 1);

const refunded = classifyReconciliation({
  orders: [order({ paymentStatus: "refunded" })],
  attempts: [{ key: "1001", id: "att-1", status: "refunded", amountPaise: 10_000 }],
  settlements: [settlement()],
  payouts: [],
});
assert.ok(refunded.exceptions.some((item) => item.kind === "refund_not_in_settlement"));
assert.ok(refunded.exceptions.some((item) => item.kind === "unallocated_settlement"));

console.log("PASS: order, collection and payout reconciliation rules");
