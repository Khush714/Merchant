import assert from "node:assert/strict";
import { parseSettlementPayload, SettlementPayloadError } from "../src/lib/settlement-payload.ts";

const row = {
  externalId: "pay_123",
  marketplaceOrderId: "987",
  orderNumber: 2847,
  grossPaise: 56700,
  commissionPaise: 1701,
  refundPaise: 0,
  adjustmentPaise: 0,
  netPaise: 54999,
  currency: "INR",
  status: "paid",
  reference: "PROVIDER_PAYOUT_REF",
  paidAt: "2026-11-17T10:00:00Z",
  updatedAt: "2026-11-17T10:00:01Z",
};
const invalid = (value, label) => {
  assert.throws(() => parseSettlementPayload({ settlements: [value] }), SettlementPayloadError, label);
};

const parsed = parseSettlementPayload({ settlements: [row] });
assert.equal(parsed.length, 1);
assert.equal(parsed[0].netPaise, 54999);
assert.equal(parsed[0].paidAt, "2026-11-17T10:00:00.000Z");
assert.equal(parseSettlementPayload({ settlements: [] }).length, 0);

invalid({ ...row, netPaise: 50000 }, "inconsistent net amount is rejected");
invalid({ ...row, currency: "USD" }, "unsupported currency is rejected");
invalid({ ...row, status: "unknown" }, "unknown status is rejected");
invalid({ ...row, paidAt: null }, "paid settlement requires a paidAt timestamp");
invalid({ ...row, updatedAt: "not-a-date" }, "invalid timestamp is rejected");
invalid({ ...row, commissionPaise: -1 }, "negative commission is rejected");
assert.throws(() => parseSettlementPayload({ settlements: [row, row] }), SettlementPayloadError, "duplicate orders are rejected");
assert.throws(() => parseSettlementPayload({ settlements: Array.from({ length: 201 }, () => row) }), SettlementPayloadError, "oversized payloads are rejected");

console.log("PASS: authoritative settlement payload validation");
