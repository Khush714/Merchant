import assert from "node:assert/strict";
import {
  buildSettlementLineDrafts, legacySettlementLineValues, SETTLEMENT_LINE_VERSION,
} from "../src/lib/settlement-line-core.ts";

const businessId = "11111111-1111-4111-8111-111111111111";
const scheduleId = "22222222-2222-4222-8222-222222222222";
const rebuiltAt = new Date("2026-11-22T10:00:00Z");
const settlements = [
  {
    id: "s-1", orderNumber: 7001, grossAmount: 70_000, commissionAmount: 2_000,
    refundAmount: 0, adjustmentAmount: -500,
    paidAt: new Date("2026-11-20T10:00:00Z"), createdAt: new Date("2026-11-20T09:00:00Z"),
    sourceUpdatedAt: new Date("2026-11-20T10:01:00Z"),
  },
  {
    id: "s-2", orderNumber: 7002, grossAmount: 50_000, commissionAmount: 1_500,
    refundAmount: 2_000, adjustmentAmount: 0,
    paidAt: null, createdAt: new Date("2026-11-21T09:00:00Z"),
    sourceUpdatedAt: new Date("2026-11-21T10:01:00Z"),
  },
  {
    id: "s-3", orderNumber: null, grossAmount: 12_000, commissionAmount: 400,
    refundAmount: 0, adjustmentAmount: 0,
    paidAt: new Date("2026-11-22T09:00:00Z"), createdAt: new Date("2026-11-22T08:00:00Z"),
    sourceUpdatedAt: null,
  },
];
const orders = [
  { id: "o-1", orderNumber: 7001 },
  { id: "o-2", orderNumber: 7002 },
];
const attempts = [
  { id: "a-newer", orderId: "o-1", createdAt: new Date("2026-11-20T10:00:00Z") },
  { id: "a-older", orderId: "o-1", createdAt: new Date("2026-11-20T09:55:00Z") },
  { id: "a-2", orderId: "o-2", createdAt: new Date("2026-11-21T09:10:00Z") },
];

const financialFields = [
  "settlementId", "orderId", "paymentAttemptId", "grossPaise", "commissionPaise",
  "gatewayFeePaise", "taxPaise", "refundPaise", "adjustmentPaise", "netPaise",
  "source", "sourceAt", "expectedNetPaise", "matchesAuthoritative",
];
const pick = (row) => Object.fromEntries(financialFields.map((key) => [key, row[key]]));

function compare(schedule, label) {
  const legacy = legacySettlementLineValues({ businessId, settlements, orders, attempts, schedule });
  const incremental = buildSettlementLineDrafts({
    businessId, settlements, orders, attempts, schedule, feeScheduleId: scheduleId, rebuiltAt,
  });
  assert.equal(incremental.length, legacy.length, `${label}: line count`);
  assert.deepEqual(incremental.map(pick), legacy.map(pick), `${label}: every financial field matches the retained legacy builder`);
  assert.equal(new Set(incremental.map((line) => line.settlementId)).size, incremental.length, `${label}: one line per settlement`);
  for (const line of incremental) {
    assert.equal(line.lineVersion, SETTLEMENT_LINE_VERSION, `${label}: version marker`);
    assert.equal(line.feeScheduleId, scheduleId, `${label}: fee schedule marker`);
    assert.equal(line.rebuiltAt, rebuiltAt, `${label}: rebuild marker`);
  }
  return incremental;
}

const defaultLines = compare(null, "default schedule");
assert.deepEqual(
  defaultLines.map((line) => [line.grossPaise, line.commissionPaise, line.gatewayFeePaise, line.taxPaise, line.netPaise]),
  [[70_000, 2_000, 0, 0, 67_500], [50_000, 1_500, 0, 0, 46_500], [12_000, 400, 0, 0, 11_600]],
  "authoritative net is preserved when no gateway/tax split applies",
);
assert.equal(defaultLines[0].orderId, "o-1");
assert.equal(defaultLines[0].paymentAttemptId, "a-newer", "legacy first-attempt linkage is preserved");
assert.equal(defaultLines[2].orderId, null);
assert.equal(defaultLines[2].paymentAttemptId, null);
assert.equal(defaultLines[2].sourceAt.toISOString(), settlements[2].paidAt.toISOString());

const configured = { commissionBps: 0, platformFixedPaise: 0, gatewayBps: 200, gatewayFixedPaise: 0, gstBps: 1800 };
const configuredLines = compare(configured, "gateway/tax schedule");
assert.equal(configuredLines[0].commissionPaise, 2_000, "authoritative commission is never recomputed");
assert.equal(configuredLines[0].gatewayFeePaise, 1_400);
assert.equal(configuredLines[0].taxPaise, 612);
assert.equal(configuredLines[0].netPaise, 65_488);
assert.equal(configuredLines[0].expectedNetPaise, 67_500, "authoritative expected net ignores gateway/tax");
assert.equal(configuredLines[0].matchesAuthoritative, false, "gateway/tax drift is reported, not silently accepted");
assert.equal(configuredLines[2].matchesAuthoritative, false);

const repeat = buildSettlementLineDrafts({
  businessId, settlements, orders, attempts, schedule: configured, feeScheduleId: scheduleId, rebuiltAt,
});
assert.deepEqual(repeat, configuredLines, "same inputs produce byte-for-byte equivalent drafts");

console.log("PASS: incremental settlement lines match the retained legacy builder");
