/**
 * Pure order-level analytics for the Insights report. No database or Next.js imports so
 * the aggregation can be unit tested with fixed rows. Money stays in paise throughout.
 *
 * The report has two deliberately different axes: `summary` follows the Revenue tab's
 * completion date, while the tables group orders by placement date (Asia/Kolkata).
 * The newer BI sections are derived from the same order facts, not from a second
 * source of truth, so paired outlets keep Marketplace-owned totals at the top.
 */
import { indiaDate } from "./closure.ts";
import type {
  AdvancedAnalytics,
  AdvancedKpis,
  AnalyticsComparisonRow,
  AnalyticsDailyRow,
  AnalyticsDeliveryRow,
  AnalyticsGroupRow,
  AnalyticsHourRow,
  AnalyticsOfferRow,
  AnalyticsProductRow,
  AnalyticsReasonRow,
  AnalyticsRepeat,
  AnalyticsToday,
  OrderStatus,
  RevenueSummary,
} from "./types.ts";

export type AnalyticsOrderItemRow = {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal?: number | null;
};

export type AnalyticsOrderRow = {
  id?: string;
  createdAt: Date | string;
  status: OrderStatus;
  fulfilment: "pickup" | "delivery";
  paymentStatus: string;
  total: number;
  discount: number;
  offerCode: string;
  customerName?: string;
  prepMinutes?: number | null;
  rejectionReason?: string;
  courierStatus?: string;
  items?: AnalyticsOrderItemRow[];
};

export type AnalyticsSettlementTotals = {
  commission: number;
  refunds: number;
  adjustments: number;
};

export type AdvancedAnalyticsOptions = {
  source?: "local" | "marketplace";
  settlements?: AnalyticsSettlementTotals | null;
  /** Every active menu item name, so zero-sale products can appear in slow movers. */
  productCatalog?: string[];
  previousRows?: AnalyticsOrderRow[];
  previousSummary?: RevenueSummary | null;
  previousLabel?: string | null;
  truncatedOrders?: boolean;
  notice?: string;
  now?: Date;
};

const DAILY_LIMIT = 100;
const OFFER_LIMIT = 50;
const PRODUCT_LIMIT = 100;
const SLOW_MOVER_LIMIT = 5;
const HOURS = 24;
const IST_OFFSET_MS = 5 * 3_600_000 + 30 * 60_000;

type Bucket = { orders: number; completed: number; grossSales: number; discounts: number };
const bucket = (): Bucket => ({ orders: 0, completed: 0, grossSales: 0, discounts: 0 });

function isCompleted(row: AnalyticsOrderRow) {
  return row.status === "completed";
}

function isCancelled(row: AnalyticsOrderRow) {
  return row.status === "cancelled" || row.status === "rejected";
}

function money(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
}

function whole(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
}

function rate(part: number, total: number) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function indiaHour(value: Date | string): number {
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return 0;
  return new Date(stamp + IST_OFFSET_MS).getUTCHours();
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 120);
}

function emptyToday(now: Date): AnalyticsToday {
  return {
    date: indiaDate(now),
    revenue: 0,
    completedOrders: 0,
    ordersPlaced: 0,
    averageOrderValue: 0,
    completionRate: 0,
  };
}

function averageOrderValue(summary: RevenueSummary) {
  return summary.completedOrders ? Math.round(summary.grossSales / summary.completedOrders) : 0;
}

function previousCompletionRate(rows: AnalyticsOrderRow[]) {
  return rate(rows.filter(isCompleted).length, rows.length);
}

function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildComparison(
  summary: RevenueSummary,
  kpis: AdvancedKpis,
  previousSummary: RevenueSummary | null,
  previousRows: AnalyticsOrderRow[],
  label: string | null,
): { rows: AnalyticsComparisonRow[]; label: string | null } {
  if (!previousSummary || !label) return { rows: [], label: null };
  const currentRate = kpis.completionRate;
  const previousRate = previousCompletionRate(previousRows);
  const rows: AnalyticsComparisonRow[] = [
    { label: "Gross sales", current: summary.grossSales, previous: previousSummary.grossSales, changePct: percentChange(summary.grossSales, previousSummary.grossSales), money: true },
    { label: "Completed orders", current: summary.completedOrders, previous: previousSummary.completedOrders, changePct: percentChange(summary.completedOrders, previousSummary.completedOrders), money: false },
    { label: "Average order value", current: averageOrderValue(summary), previous: averageOrderValue(previousSummary), changePct: percentChange(averageOrderValue(summary), averageOrderValue(previousSummary)), money: true },
    { label: "Completion rate", current: currentRate, previous: previousRate, changePct: percentChange(currentRate, previousRate), money: false },
  ];
  return { rows, label };
}

/** Build the full report from an already business- and range-scoped set of order rows. */
export function buildAdvancedAnalytics(
  rows: AnalyticsOrderRow[],
  range: { from: string | null; to: string | null },
  summary: RevenueSummary,
  options: AdvancedAnalyticsOptions = {},
): AdvancedAnalytics {
  const now = options.now ?? new Date();
  const today = emptyToday(now);
  const daily = new Map<string, Bucket>();
  const fulfilment = new Map<string, Bucket>([["pickup", bucket()], ["delivery", bucket()]]);
  const payments = new Map<string, Bucket>();
  const offers = new Map<string, { redemptions: number; discountGiven: number; grossSales: number }>();
  const hourly = Array.from({ length: HOURS }, (_, hour): AnalyticsHourRow => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    orders: 0,
    completed: 0,
    grossSales: 0,
  }));
  const products = new Map<string, {
    name: string;
    unitsSold: number;
    grossSales: number;
    orders: Set<string>;
    prepTotal: number;
    prepCount: number;
  }>();
  const cancellations = new Map<string, { orders: number; lostValue: number }>();
  const delivery = new Map<string, { orders: number; completed: number; cancelled: number }>([
    ["pickup", { orders: 0, completed: 0, cancelled: 0 }],
    ["delivery", { orders: 0, completed: 0, cancelled: 0 }],
  ]);
  const customers = new Map<string, number>();
  let ordersPlaced = 0, completed = 0, discountsGiven = 0, failedPayments = 0;

  // Seed the full menu first so an item that never sold is still a real slow mover.
  for (const rawName of options.productCatalog ?? []) {
    const name = cleanName(rawName) || "Unnamed item";
    if (!products.has(name)) {
      products.set(name, { name, unitsSold: 0, grossSales: 0, orders: new Set<string>(), prepTotal: 0, prepCount: 0 });
    }
  }

  for (const [index, row] of rows.entries()) {
    const day = indiaDate(new Date(row.createdAt));
    const dayBucket = daily.get(day) ?? bucket();
    const methodBucket = fulfilment.get(row.fulfilment) ?? bucket();
    const deliveryBucket = delivery.get(row.fulfilment) ?? { orders: 0, completed: 0, cancelled: 0 };
    const status = row.paymentStatus.trim() || "unpaid";
    const paymentBucket = payments.get(status) ?? bucket();
    const orderKey = row.id || `${day}-${index}`;

    ordersPlaced += 1;
    dayBucket.orders += 1;
    methodBucket.orders += 1;
    deliveryBucket.orders += 1;
    paymentBucket.orders += 1;
    hourly[indiaHour(row.createdAt)].orders += 1;

    if (day === today.date) {
      today.ordersPlaced += 1;
      if (isCompleted(row)) today.completedOrders += 1;
    }

    const customer = cleanName(row.customerName).toLowerCase();
    if (customer && customer !== "guest") customers.set(customer, (customers.get(customer) ?? 0) + 1);

    if (isCompleted(row)) {
      const total = money(row.total), discount = money(row.discount);
      completed += 1;
      discountsGiven += discount;
      dayBucket.completed += 1;
      dayBucket.grossSales += total;
      dayBucket.discounts += discount;
      methodBucket.completed += 1;
      methodBucket.grossSales += total;
      deliveryBucket.completed += 1;
      paymentBucket.completed += 1;
      paymentBucket.grossSales += total;
      hourly[indiaHour(row.createdAt)].completed += 1;
      hourly[indiaHour(row.createdAt)].grossSales += total;
      if (day === today.date) today.revenue += total;

      const prep = Number.isFinite(row.prepMinutes) ? Math.max(0, Math.round(Number(row.prepMinutes))) : null;
      for (const item of row.items ?? []) {
        const name = cleanName(item.name) || "Unnamed item";
        const quantity = whole(item.quantity);
        const lineTotal = money(item.lineTotal ?? Number(item.unitPrice || 0) * quantity);
        const product = products.get(name) ?? { name, unitsSold: 0, grossSales: 0, orders: new Set<string>(), prepTotal: 0, prepCount: 0 };
        product.unitsSold += quantity;
        product.grossSales += lineTotal;
        product.orders.add(orderKey);
        if (prep !== null) { product.prepTotal += prep; product.prepCount += 1; }
        products.set(name, product);
      }

      const code = row.offerCode.trim();
      if (code) {
        const offer = offers.get(code) ?? { redemptions: 0, discountGiven: 0, grossSales: 0 };
        offer.redemptions += 1;
        offer.discountGiven += discount;
        offer.grossSales += total;
        offers.set(code, offer);
      }
    } else if (isCancelled(row)) {
      deliveryBucket.cancelled += 1;
      const reason = cleanName(row.rejectionReason).slice(0, 120) || "Not specified";
      const entry = cancellations.get(reason) ?? { orders: 0, lostValue: 0 };
      entry.orders += 1;
      entry.lostValue += money(row.total);
      cancellations.set(reason, entry);
    }
    if (status === "failed") failedPayments += 1;

    daily.set(day, dayBucket);
    fulfilment.set(row.fulfilment, methodBucket);
    delivery.set(row.fulfilment, deliveryBucket);
    payments.set(status, paymentBucket);
  }

  today.averageOrderValue = today.completedOrders ? Math.round(today.revenue / today.completedOrders) : 0;
  today.completionRate = rate(today.completedOrders, today.ordersPlaced);

  const kpis: AdvancedKpis = {
    ordersPlaced,
    completionRate: rate(completed, ordersPlaced),
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
  const allProductRows: AnalyticsProductRow[] = [...products.values()]
    .map((value) => ({
      name: value.name,
      unitsSold: value.unitsSold,
      grossSales: value.grossSales,
      orders: value.orders.size,
      avgPrepMinutes: value.prepCount ? Math.round(value.prepTotal / value.prepCount) : null,
    }));
  const productRows = allProductRows
    .filter((row) => row.unitsSold > 0)
    .sort((a, b) => b.grossSales - a.grossSales || a.name.localeCompare(b.name))
    .slice(0, PRODUCT_LIMIT);
  // Slow movers are the fewest units sold across the whole menu, not the tail of
  // the revenue-capped best-seller table. Zero-sale items rank first.
  const slowMovers = [...allProductRows]
    .sort((a, b) => a.unitsSold - b.unitsSold || a.grossSales - b.grossSales || a.name.localeCompare(b.name))
    .slice(0, SLOW_MOVER_LIMIT);
  const cancellationRows: AnalyticsReasonRow[] = [...cancellations.entries()]
    .map(([reason, value]) => ({ reason, ...value }))
    .sort((a, b) => b.orders - a.orders || a.reason.localeCompare(b.reason));
  const repeatCustomers = [...customers.values()].filter((count) => count > 1).length;
  const repeat: AnalyticsRepeat = {
    customers: customers.size,
    repeatCustomers,
    repeatOrders: [...customers.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    repeatRate: rate(repeatCustomers, customers.size),
    basis: "Matched by customer name on the order",
  };
  const deliveryRows: AnalyticsDeliveryRow[] = (["pickup", "delivery"] as const).map((key) => {
    const value = delivery.get(key) ?? { orders: 0, completed: 0, cancelled: 0 };
    return {
      label: key === "pickup" ? "Pickup" : "Delivery",
      orders: value.orders,
      completed: value.completed,
      cancelled: value.cancelled,
      completionRate: rate(value.completed, value.orders),
    };
  });
  const settlementTotals = options.settlements;
  const commission = Math.max(0, money(settlementTotals?.commission));
  const refunds = Math.max(0, money(settlementTotals?.refunds));
  const adjustments = Math.round(Number(settlementTotals?.adjustments ?? 0)) || 0;
  const netFromFees = summary.grossSales - commission - refunds + adjustments;
  const profitability = {
    grossSales: summary.grossSales,
    discounts: discountsGiven,
    commission,
    refunds,
    adjustments,
    netPaid: summary.netPaid,
    netAfterFees: summary.netPaid || netFromFees,
    source: settlementTotals ? "settlements" as const : summary.netPaid ? "revenue" as const : "none" as const,
  };
  const comparison = buildComparison(summary, kpis, options.previousSummary ?? null, options.previousRows ?? [], options.previousLabel ?? null);

  return {
    from: range.from,
    to: range.to,
    currency: "INR",
    source: options.source ?? "local",
    summary,
    kpis,
    daily: dailyRows.slice(0, DAILY_LIMIT),
    fulfilment: fulfilmentRows,
    payments: paymentRows,
    offers: offerRows,
    today,
    hourly,
    products: productRows,
    slowMovers,
    cancellations: cancellationRows,
    repeat,
    delivery: deliveryRows,
    profitability,
    comparison: comparison.rows,
    comparisonLabel: comparison.label,
    ordersTruncated: !!options.truncatedOrders,
    notice: options.notice,
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
    today: emptyToday(new Date()),
    hourly: [],
    products: [],
    slowMovers: [],
    cancellations: [],
    repeat: { customers: 0, repeatCustomers: 0, repeatOrders: 0, repeatRate: 0, basis: "Not available" },
    delivery: [],
    profitability: {
      grossSales: summary.grossSales,
      discounts: 0,
      commission: 0,
      refunds: 0,
      adjustments: 0,
      netPaid: summary.netPaid,
      netAfterFees: summary.netPaid,
      source: summary.netPaid ? "revenue" : "none",
    },
    comparison: [],
    comparisonLabel: null,
    ordersTruncated: false,
    notice: "Order-level breakdowns stay in Marketplace, which is authoritative for this listing. The totals above come from Marketplace.",
  };
}
