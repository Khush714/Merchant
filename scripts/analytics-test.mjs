import assert from "node:assert/strict";
import { buildAdvancedAnalytics, marketplaceAnalytics } from "../src/lib/analytics-core.ts";

const range = { from: "2026-11-18", to: "2026-11-20" };
const summary = { from: range.from, to: range.to, grossSales: 80_000, netPaid: 0, completedOrders: 2, paidSettlements: 0, currency: "INR" };
const rows = [
  { createdAt: "2026-11-18T05:00:00.000Z", status: "completed", fulfilment: "delivery", paymentStatus: "paid", total: 30_000, discount: 2_000, offerCode: "SAVE" },
  { createdAt: "2026-11-18T06:00:00.000Z", status: "new", fulfilment: "pickup", paymentStatus: "unpaid", total: 10_000, discount: 0, offerCode: "" },
  { createdAt: "2026-11-19T18:30:00.000Z", status: "completed", fulfilment: "pickup", paymentStatus: "failed", total: 50_000, discount: 0, offerCode: "SAVE" },
  { createdAt: "2026-11-20T01:00:00.000Z", status: "rejected", fulfilment: "delivery", paymentStatus: "paid", total: 20_000, discount: 500, offerCode: "" },
];

const report = buildAdvancedAnalytics(rows, range, summary);
assert.equal(report.source, "local");
assert.equal(report.currency, "INR");
assert.equal(report.summary.grossSales, 80_000);
assert.deepEqual(report.kpis, { ordersPlaced: 4, completionRate: 50, discountsGiven: 2_000, failedPayments: 1 });

// Placement dates use India Standard Time, so the 18:30Z row belongs to the 20th.
assert.deepEqual(report.daily.map((row) => row.date), ["2026-11-20", "2026-11-18"]);
assert.deepEqual(report.daily[0], { date: "2026-11-20", orders: 2, completed: 1, grossSales: 50_000, discounts: 0 });
assert.deepEqual(report.daily[1], { date: "2026-11-18", orders: 2, completed: 1, grossSales: 30_000, discounts: 2_000 });
assert.equal(report.truncated, false);

assert.deepEqual(report.fulfilment, [
  { label: "Pickup", orders: 2, completed: 1, grossSales: 50_000 },
  { label: "Delivery", orders: 2, completed: 1, grossSales: 30_000 },
]);
assert.deepEqual(report.payments.map((row) => row.label), ["Paid", "Failed", "Unpaid"]);
assert.equal(report.payments[0].grossSales, 30_000);
assert.deepEqual(report.offers, [{ code: "SAVE", redemptions: 2, discountGiven: 2_000, grossSales: 80_000 }]);

const empty = buildAdvancedAnalytics([], range, { ...summary, grossSales: 0, completedOrders: 0 });
assert.deepEqual(empty.kpis, { ordersPlaced: 0, completionRate: 0, discountsGiven: 0, failedPayments: 0 });
assert.equal(empty.daily.length, 0);
assert.equal(empty.offers.length, 0);
assert.equal(empty.fulfilment.length, 2);
assert.equal(empty.truncated, false);

const many = Array.from({ length: 120 }, (_, index) => ({
  createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  status: "completed", fulfilment: "pickup", paymentStatus: "paid", total: 100, discount: 0, offerCode: "",
}));
const capped = buildAdvancedAnalytics(many, { from: null, to: null }, summary);
assert.equal(capped.daily.length, 100);
assert.equal(capped.truncated, true);

const clamped = buildAdvancedAnalytics([{
  createdAt: "2026-11-18T05:00:00.000Z", status: "completed", fulfilment: "pickup",
  paymentStatus: "paid", total: -100, discount: -50, offerCode: "",
}], range, summary);
assert.equal(clamped.kpis.discountsGiven, 0);
assert.equal(clamped.daily[0].grossSales, 0);

const paired = marketplaceAnalytics(range, summary);
assert.equal(paired.source, "marketplace");
assert.equal(paired.kpis, null);
assert.equal(paired.daily.length, 0);
assert.equal(paired.fulfilment.length, 0);
assert.equal(paired.payments.length, 0);
assert.equal(paired.offers.length, 0);
assert.match(paired.notice, /Marketplace/);

console.log("PASS: advanced analytics KPIs and tables");
