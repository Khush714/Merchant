import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { menuItems, orderItems, orders, settlements } from "@/db/schema";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteMenuItems,
  parseRemoteOrders,
} from "@/lib/marketplace-bridge";
import { loadRevenueSummary } from "@/lib/revenue-data";
import { previousRevenueRange, type NormalizedRevenueRange } from "@/lib/revenue";
import type { Order, RevenueSummary } from "@/lib/types";
import {
  buildAdvancedAnalytics,
  type AnalyticsOrderRow,
  type AnalyticsSettlementTotals,
} from "./analytics-core";

const REMOTE_PAGE_SIZE = 50; // Marketplace's order inbox clamps `limit` to 50.
const LOCAL_LIMIT = 1_000;
// The remote path must reach the same documented cap as the local path: 50 ├ù 20 = 1,000.
const MAX_REMOTE_PAGES = 20;

type OrderFactResult = { rows: AnalyticsOrderRow[]; truncated: boolean };

function comparisonLabel(range: NormalizedRevenueRange) {
  if (!range.from || !range.to) return null;
  const from = Date.parse(`${range.from}T00:00:00+05:30`);
  const to = Date.parse(`${range.to}T00:00:00+05:30`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "Previous period";
  const days = Math.max(1, Math.round((to - from) / 86_400_000) + 1);
  if (days <= 7) return "Previous week";
  if (days <= 31) return "Previous month";
  return "Previous period";
}

function analyticsRow(order: Order): AnalyticsOrderRow {
  return {
    id: order.id,
    createdAt: order.createdAt,
    status: order.status as AnalyticsOrderRow["status"],
    fulfilment: order.fulfilment as AnalyticsOrderRow["fulfilment"],
    paymentStatus: order.paymentStatus,
    total: order.total,
    discount: order.discount,
    offerCode: order.offerCode,
    customerName: order.customerName,
    prepMinutes: order.prepMinutes,
    rejectionReason: order.rejectionReason,
    courierStatus: order.courierStatus,
    items: (order.items ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal ?? null,
    })),
  };
}

function remoteParams(range: NormalizedRevenueRange, page: number) {
  const params = new URLSearchParams({ status: "all", page: String(page), limit: String(REMOTE_PAGE_SIZE) });
  if (range.from && range.to) {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return params;
}

/**
 * Paired outlets read order facts from the same Marketplace token-scoped inbox
 * the order book uses. Paging is bounded so a large range cannot stall a tab;
 * the report flags truncation instead of silently under-reporting.
 */
async function loadRemoteOrderFacts(businessId: string, range: NormalizedRevenueRange): Promise<OrderFactResult> {
  const rows: AnalyticsOrderRow[] = [];
  for (let page = 1; page <= MAX_REMOTE_PAGES; page += 1) {
    const payload = await marketplaceFetch(businessId, `/api/integration/merchant/orders?${remoteParams(range, page)}`);
    const parsed = parseMarketplaceResponse(payload, (value) => parseRemoteOrders(value, businessId));
    rows.push(...parsed.orders.map(analyticsRow));
    if (!parsed.hasMore) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function loadLocalOrderFacts(businessId: string, range: NormalizedRevenueRange): Promise<OrderFactResult> {
  const filters = [eq(orders.businessId, businessId)];
  if (range.fromDate) filters.push(gte(orders.createdAt, range.fromDate));
  if (range.toExclusiveDate) filters.push(lt(orders.createdAt, range.toExclusiveDate));
  const found = await db.select({
    id: orders.id,
    createdAt: orders.createdAt,
    status: orders.status,
    fulfilment: orders.fulfilment,
    paymentStatus: orders.paymentStatus,
    total: orders.total,
    discount: orders.discount,
    offerCode: orders.offerCode,
    customerName: orders.customerName,
    prepMinutes: orders.prepMinutes,
    rejectionReason: orders.rejectionReason,
    courierStatus: orders.courierStatus,
  }).from(orders).where(and(...filters)).orderBy(desc(orders.createdAt)).limit(LOCAL_LIMIT + 1);
  const truncated = found.length > LOCAL_LIMIT;
  const selected = found.slice(0, LOCAL_LIMIT);
  if (!selected.length) return { rows: [], truncated };
  const itemRows = await db.select({
    orderId: orderItems.orderId,
    name: orderItems.name,
    quantity: orderItems.quantity,
    unitPrice: orderItems.unitPrice,
  }).from(orderItems).where(inArray(orderItems.orderId, selected.map((order) => order.id))).orderBy(asc(orderItems.orderId));
  const byOrder = new Map<string, AnalyticsOrderRow["items"]>();
  for (const item of itemRows) {
    const list = byOrder.get(item.orderId) ?? [];
    list.push({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.unitPrice * item.quantity });
    byOrder.set(item.orderId, list);
  }
  return {
    rows: selected.map((order) => ({
      ...order,
      status: order.status as AnalyticsOrderRow["status"],
      fulfilment: order.fulfilment as AnalyticsOrderRow["fulfilment"],
      items: byOrder.get(order.id) ?? [],
    })),
    truncated,
  };
}

async function loadSettlementTotals(businessId: string, range: NormalizedRevenueRange): Promise<AnalyticsSettlementTotals> {
  const filters = [eq(settlements.businessId, businessId), eq(settlements.status, "paid")];
  if (range.fromDate) filters.push(gte(settlements.paidAt, range.fromDate));
  if (range.toExclusiveDate) filters.push(lt(settlements.paidAt, range.toExclusiveDate));
  const [totals] = await db.select({
    commission: sql<number>`coalesce(sum(${settlements.commissionAmount}), 0)::bigint`.mapWith(Number),
    refunds: sql<number>`coalesce(sum(${settlements.refundAmount}), 0)::bigint`.mapWith(Number),
    adjustments: sql<number>`coalesce(sum(${settlements.adjustmentAmount}), 0)::bigint`.mapWith(Number),
  }).from(settlements).where(and(...filters));
  return {
    commission: Math.max(0, Number(totals?.commission ?? 0)),
    refunds: Math.max(0, Number(totals?.refunds ?? 0)),
    adjustments: Number(totals?.adjustments ?? 0),
  };
}

/** Active menu names seed product movement so an item with no sales is still a slow mover. */
async function loadProductCatalog(businessId: string, paired: boolean): Promise<string[]> {
  if (paired) {
    const remote = await marketplaceFetch(businessId, "/api/integration/merchant/menu/items");
    return parseMarketplaceResponse(remote, (body) => parseRemoteMenuItems(body, businessId))
      .filter((item) => !item.archived)
      .map((item) => item.name);
  }
  const rows = await db.select({ name: menuItems.name })
    .from(menuItems)
    .where(and(eq(menuItems.businessId, businessId), eq(menuItems.archived, false)))
    .orderBy(asc(menuItems.name))
    .limit(500);
  return rows.map((row) => row.name);
}

/**
 * One source for the Insights report. Totals always come from the Revenue loader so
 * paired and local outlets agree with the Revenue tab; the new BI sections are
 * derived from the same order facts (Marketplace token-scoped for paired outlets).
 */
export async function loadAdvancedAnalytics(
  businessId: string,
  range: NormalizedRevenueRange,
): Promise<ReturnType<typeof buildAdvancedAnalytics>> {
  const previous = previousRevenueRange(range);
  const [summary, paired] = await Promise.all([
    loadRevenueSummary(businessId, range),
    getMarketplaceLink(businessId),
  ]);
  const [settlementTotals, previousSummary, productCatalog] = await Promise.all([
    loadSettlementTotals(businessId, range),
    previous ? loadRevenueSummary(businessId, previous) : Promise.resolve(null),
    loadProductCatalog(businessId, !!paired),
  ]);
  const [current, prior] = await Promise.all([
    paired ? loadRemoteOrderFacts(businessId, range) : loadLocalOrderFacts(businessId, range),
    previous
      ? paired
        ? loadRemoteOrderFacts(businessId, previous)
        : loadLocalOrderFacts(businessId, previous)
      : Promise.resolve<OrderFactResult>({ rows: [], truncated: false }),
  ]);

  return buildAdvancedAnalytics(current.rows, range, summary, {
    source: paired ? "marketplace" : "local",
    settlements: settlementTotals,
    productCatalog,
    previousRows: prior.rows,
    previousSummary,
    previousLabel: previous ? comparisonLabel(range) : null,
    truncatedOrders: current.truncated || prior.truncated,
    notice: paired
      ? "Order facts are read from your Marketplace listing. Headline totals and item sales remain Marketplace-owned; the extra breakdowns are derived from those order facts."
      : undefined,
  });
}
