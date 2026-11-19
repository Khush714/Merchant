import assert from "node:assert/strict";
import { localItemAnalytics } from "../src/lib/item-analytics-core.ts";
import { parseRemoteItemAnalytics } from "../src/lib/marketplace-payload.ts";

const bounds = {
  from: "2026-11-01",
  to: "2026-11-07",
  fromDate: new Date("2026-10-31T18:30:00.000Z"),
  toExclusiveDate: new Date("2026-11-07T18:30:00.000Z"),
};

const local = localItemAnalytics([
  { orderId: "a", itemId: "1", name: "Bowl", quantity: 2, unitPrice: 30_000, at: "2026-11-02T05:00:00.000Z" },
  { orderId: "b", itemId: "1", name: "Bowl", quantity: 1, unitPrice: 30_000, at: "2026-11-06T05:00:00.000Z" },
  { orderId: "c", itemId: null, name: "Juice", quantity: 3, unitPrice: 10_000, at: "2026-10-31T18:29:59.000Z" },
  { orderId: "d", itemId: null, name: "Tea", quantity: 1, unitPrice: 10_000, at: "2026-11-07T18:30:00.000Z" },
], bounds);
assert.deepEqual(local, {
  from: "2026-11-01",
  to: "2026-11-07",
  items: [{ itemId: "1", name: "Bowl", unitsSold: 3, grossSales: 90_000, orders: 2 }],
  unitsSold: 3,
  grossSales: 90_000,
  itemsSold: 1,
  currency: "INR",
});

const payload = {
  ok: true,
  analytics: {
    from: null,
    to: null,
    items: [{ itemId: "1700", name: "Harvest Buddha Bowl", unitsSold: 2, grossSales: 69_800, orders: 2 }],
    unitsSold: 2,
    grossSales: 69_800,
    itemsSold: 1,
    currency: "INR",
  },
};
assert.deepEqual(parseRemoteItemAnalytics(payload), payload.analytics);
assert.throws(() => parseRemoteItemAnalytics({ ...payload, ok: false }), /request failed/);
assert.throws(() => parseRemoteItemAnalytics({ ...payload, analytics: { ...payload.analytics, currency: "USD" } }), /currency/);
assert.throws(() => parseRemoteItemAnalytics({
  ...payload,
  analytics: { ...payload.analytics, items: [{ ...payload.analytics.items[0], unitsSold: -1 }] },
}), /unitsSold/);
assert.throws(() => parseRemoteItemAnalytics({
  ...payload,
  analytics: { ...payload.analytics, items: [{ ...payload.analytics.items[0], itemId: "BAD" }] },
}), /itemId/);

console.log("PASS: item analytics parser and local rollup are strict and range-aware");
