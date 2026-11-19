/**
 * Pure order-level analytics for the Insights report. No database or Next.js imports so
 * the aggregation can be unit tested with fixed rows. Money stays in paise throughout.
 *
 * The report has two deliberately different axes: `summary` follows the Revenue tab's
 * completion date, while the tables group orders by placement date (Asia/Kolkata).
 */
import { indiaDate } from "./closure.ts";
import type {
  AdvancedAnalytics,
  AdvancedKpis,
  AnalyticsDailyRow,
  AnalyticsGroupRow,
  AnalyticsOfferRow,
  OrderStatus,
  RevenueSummary,
} from "./types.ts";

export type AnalyticsOrderRow = {
  createdAt: Date | string;
  status: OrderStatus;
  fulfilment: "pickup" | "delivery";
  paymentStatus: string;
  total: number;
  discount: number;
  offerCode: string;
};

const DAILY_LIMIT = 100;
const OFFER_LIMIT = 50;

type Bucket = { orders: number; completed: number; grossSales: number; discounts: number };
const bucket = (): Bucket => ({ orders: 0, completed: 0, grossSales: 0, discounts: 0 });

function isCompleted(row: AnalyticsOrderRow) {
  return row.status === "completed";
}

function money(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
}

/** Build the full report from an already business- and range-scoped set of order rows. */
export function buildAdvancedAnalytics(
  rows: AnalyticsOrderRow[],
  range: { from: string | null; to: string | null },
  summary: RevenueSummary,
): AdvancedAnalytics {
  const base: AdvancedAnalytics = {
    from: range.from,
    to: range.to,
    currency: "INR",
    source: "local",
    summary,
    kpis: null,
    daily: [],
    fulfilment: [],
    payments: [],
    offers: [],
  };
  const daily = new Map<string, Bucket>();
  const fulfilment = new Map<string, Bucket>([["pickup", bucket()], ["delivery", bucket()]]);
  const payments = new Map<string, Bucket>();
  const offers = new Map<string, { redemptions: number; discountGiven: number; grossSales: number }>();
  let ordersPlaced = 0, completed = 0, discountsGiven = 0, failedPayments = 0;

  for (const row of rows) {
    const day = indiaDate(new Date(row.createdAt));
    const dayBucket = daily.get(day) ?? bucket();
    const methodBucket = fulfilment.get(row.fulfilment) ?? bucket();
    const status = row.paymentStatus.trim() || "unpaid";
    const paymentBucket = payments.get(status) ?? bucket();

    ordersPlaced += 1;
    dayBucket.orders += 1;
    methodBucket.orders += 1;
    paymentBucket.orders += 1;

    if (isCompleted(row)) {
      const total = money(row.total), discount = money(row.discount);
      completed += 1;
      discountsGiven += discount;
      dayBucket.completed += 1;
      dayBucket.grossSales += total;
      dayBucket.discounts += discount;
      methodBucket.completed += 1;
      methodBucket.grossSales += total;
      paymentBucket.completed += 1;
      paymentBucket.grossSales += total;
      const code = row.offerCode.trim();
      if (code) {
        const offer = offers.get(code) ?? { redemptions: 0, discountGiven: 0, grossSales: 0 };
        offer.redemptions += 1;
        offer.discountGiven += discount;
        offer.grossSales += total;
        offers.set(code, offer);
      }
    }
    if (status === "failed") failedPayments += 1;

    daily.set(day, dayBucket);
    fulfilment.set(row.fulfilment, methodBucket);
    payments.set(status, paymentBucket);
  }

  const kpis: AdvancedKpis = {
    ordersPlaced,
    completionRate: ordersPlaced ? Math.round((completed / ordersPlaced) * 1000) / 10 : 0,
    discountsGiven,
    failedPayments,
  };
  const dailyRows: AnalyticsDailyRow[] = [...daily.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, value]) => ({ date, ...value }));
  const fulfilmentRows: AnalyticsGroupRow[] = (["pickup", "delivery"] as const).map((label) => {
    const value = fulfilment.get(label) ?? bucket();
    return { label: label === "pickup" ? "Pickup" : "Delivery", orders: value.orders, completed: value.completed, grossSales: value.grossSales };
  });
  const paymentRows: AnalyticsGroupRow[] = [...payments.entries()]
    .sort(([a, av], [b, bv]) => bv.orders - av.orders || a.localeCompare(b))
    .map(([label, value]) => ({ label: label.charAt(0).toUpperCase() + label.slice(1), orders: value.orders, completed: value.completed, grossSales: value.grossSales }));
  const offerRows: AnalyticsOfferRow[] = [...offers.entries()]
    .sort(([a, av], [b, bv]) => bv.discountGiven - av.discountGiven || a.localeCompare(b))
    .slice(0, OFFER_LIMIT)
    .map(([code, value]) => ({ code, ...value }));

  return {
    ...base,
    kpis,
    daily: dailyRows.slice(0, DAILY_LIMIT),
    fulfilment: fulfilmentRows,
    payments: paymentRows,
    offers: offerRows,
    truncated: dailyRows.length > DAILY_LIMIT,
  };
}

/** Paired outlets have no local order rows; only the authoritative summary is available. */
export function marketplaceAnalytics(
  range: { from: string | null; to: string | null },
  summary: RevenueSummary,
): AdvancedAnalytics {
  return {
    from: range.from,
    to: range.to,
    currency: "INR",
    source: "marketplace",
    summary,
    kpis: null,
    daily: [],
    fulfilment: [],
    payments: [],
    offers: [],
    notice: "Order-level breakdowns stay in Marketplace, which is authoritative for this listing. The totals above come from Marketplace.",
  };
}
