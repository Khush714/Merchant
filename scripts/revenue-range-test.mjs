import assert from "node:assert/strict";
import {
  normalizeRevenueRange,
  rangeForPreset,
  revenueRangeKey,
  revenueRangeLabel,
} from "../src/lib/revenue.ts";
import { parseRemoteRevenue } from "../src/lib/marketplace-payload.ts";

const now = new Date("2026-11-19T06:00:00.000Z"); // 11:30 IST
assert.deepEqual(rangeForPreset("1w", now), { from: "2026-11-12", to: "2026-11-19" });
assert.deepEqual(rangeForPreset("1m", now), { from: "2026-10-19", to: "2026-11-19" });
assert.deepEqual(rangeForPreset("6m", now), { from: "2026-05-19", to: "2026-11-19" });
assert.deepEqual(rangeForPreset("all", now), { from: null, to: null });
assert.equal(revenueRangeKey(rangeForPreset("all", now)), "all");
assert.match(revenueRangeLabel(rangeForPreset("1w", now)), /Nov 2026/);

const range = normalizeRevenueRange("2026-11-01", "2026-11-07");
assert.equal(range.fromDate.toISOString(), "2026-10-31T18:30:00.000Z");
assert.equal(range.toExclusiveDate.toISOString(), "2026-11-07T18:30:00.000Z");
assert.equal(normalizeRevenueRange("", "").from, null);
assert.equal(normalizeRevenueRange("2026-11-01", ""), null);
assert.equal(normalizeRevenueRange("2026-02-30", "2026-03-01"), null);
assert.equal(normalizeRevenueRange("2026-11-08", "2026-11-07"), null);

const payload = {
  ok: true,
  revenue: {
    from: "2026-11-01", to: "2026-11-07", grossSales: 125000, netPaid: 112300,
    completedOrders: 12, paidSettlements: 11, currency: "INR",
  },
};
assert.deepEqual(parseRemoteRevenue(payload), payload.revenue);
assert.throws(() => parseRemoteRevenue({ ...payload, revenue: { ...payload.revenue, currency: "USD" } }));
assert.throws(() => parseRemoteRevenue({ ...payload, revenue: { ...payload.revenue, netPaid: "112300" } }));

console.log("PASS: revenue ranges and authoritative revenue payload validation");
