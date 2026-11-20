import assert from "node:assert/strict";
import { buildAdvancedAnalytics, marketplaceAnalytics } from "../src/lib/analytics-core.ts";
import { normalizeRevenueRange, previousRevenueRange } from "../src/lib/revenue.ts";

const range = { from: "2026-11-18", to: "2026-11-20" };
const summary = { from: range.from, to: range.to, grossSales: 80_000, netPaid: 0, completedOrders: 2, paidSettlements: 0, currency: "INR" };
const rows = [
  { id: "a1", createdAt: "2026-11-18T05:00:00.000Z", status: "completed", fulfilment: "delivery", paymentStatus: "paid", total: 30_000, discount: 2_000, offerCode: "SAVE", customerName: "Asha", prepMinutes: 18, items: [{ name: "Paneer Tikka", quantity: 2, unitPrice: 12_000, lineTotal: 24_000 }] },
  { id: "a2", createdAt: "2026-11-18T06:00:00.000Z", status: "new", fulfilment: "pickup", paymentStatus: "unpaid", total: 10_000, discount: 0, offerCode: "", customerName: "Asha" },
  { id: "a3", createdAt: "2026-11-19T18:30:00.000Z", status: "completed", fulfilment: "pickup", paymentStatus: "failed", total: 50_000, discount: 0, offerCode: "SAVE", customerName: "Ravi", prepMinutes: 24, items: [{ name: "Paneer Tikka", quantity: 1, unitPrice: 12_000, lineTotal: 12_000 }, { name: "Dal Makhani", quantity: 2, unitPrice: 19_000, lineTotal: 38_000 }] },
  { id: "a4", createdAt: "2026-11-20T01:00:00.000Z", status: "rejected", fulfilment: "delivery", paymentStatus: "paid", total: 20_000, discount: 500, offerCode: "", customerName: "Ravi", rejectionReason: "Out of stock" },
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

// The expanded BI views are derived from the same order facts.
assert.equal(report.today.date, "2026-11-20");
assert.equal(report.today.revenue, 50_000, "18:30Z on 19 Nov is 20 Nov in India Standard Time");
assert.equal(report.today.completedOrders, 1);
assert.equal(report.hourly.length, 24);
assert.equal(report.hourly[10].orders, 1, "05:00Z is 10:30 IST");
assert.equal(report.hourly[10].grossSales, 30_000);
assert.deepEqual(report.products.map((row) => row.name), ["Dal Makhani", "Paneer Tikka"]);
assert.equal(report.products[1].unitsSold, 3);
assert.equal(report.products[1].avgPrepMinutes, 21);
assert.deepEqual(report.cancellations, [{ reason: "Out of stock", orders: 1, lostValue: 20_000 }]);
assert.deepEqual(report.repeat, { customers: 2, repeatCustomers: 2, repeatOrders: 2, repeatRate: 100, basis: "Matched by customer name on the order" });
assert.deepEqual(report.delivery.map((row) => [row.label, row.orders, row.completed, row.cancelled]), [["Pickup", 2, 1, 0], ["Delivery", 2, 1, 1]]);

const biReport = buildAdvancedAnalytics(rows, range, summary, {
  settlements: { commission: 5_000, refunds: 1_000, adjustments: -200 },
  previousRows: [
    { createdAt: "2026-11-10T05:00:00.000Z", status: "completed", fulfilment: "pickup", paymentStatus: "paid", total: 40_000, discount: 0, offerCode: "" },
    { createdAt: "2026-11-11T05:00:00.000Z", status: "new", fulfilment: "pickup", paymentStatus: "unpaid", total: 10_000, discount: 0, offerCode: "" },
  ],
  previousSummary: { from: "2026-11-10", to: "2026-11-11", grossSales: 60_000, netPaid: 0, completedOrders: 1, paidSettlements: 0, currency: "INR" },
  previousLabel: "Previous week",
  truncatedOrders: true,
});
assert.equal(biReport.profitability.source, "settlements");
assert.equal(biReport.profitability.netAfterFees, 73_800);
assert.equal(biReport.comparisonLabel, "Previous week");
assert.equal(biReport.comparison.length, 4);
assert.equal(biReport.comparison[0].changePct, 33.3);
assert.equal(biReport.ordersTruncated, true);

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
assert.equal(paired.hourly.length, 0);
assert.equal(paired.products.length, 0);
assert.equal(paired.comparison.length, 0);
assert.equal(paired.profitability.netPaid, 0);

const previous = previousRevenueRange(normalizeRevenueRange("2026-11-18", "2026-11-20"));
assert.equal(previous.from, "2026-11-15");
assert.equal(previous.to, "2026-11-17");
assert.equal(previousRevenueRange(normalizeRevenueRange(null, null)), null);

console.log("PASS: advanced analytics KPIs and tables");
