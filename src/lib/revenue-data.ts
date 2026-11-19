import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, settlements } from "@/db/schema";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteRevenue,
} from "@/lib/marketplace-bridge";
import type { NormalizedRevenueRange } from "@/lib/revenue";
import type { RevenueSummary } from "@/lib/types";

/**
 * The single source for range revenue, shared by the JSON API and CSV exports.
 * Paired listings are calculated by Marketplace; unpaired rows stay local.
 */
export async function loadRevenueSummary(
  businessId: string,
  range: NormalizedRevenueRange,
): Promise<RevenueSummary> {
  if (await getMarketplaceLink(businessId)) {
    const remoteParams = new URLSearchParams();
    if (range.from && range.to) {
      remoteParams.set("from", range.from);
      remoteParams.set("to", range.to);
    }
    const suffix = remoteParams.toString();
    const remote = await marketplaceFetch(
      businessId,
      `/api/integration/merchant/revenue${suffix ? `?${suffix}` : ""}`,
    );
    return parseMarketplaceResponse(remote, parseRemoteRevenue);
  }

  const orderFilters = [eq(orders.businessId, businessId), eq(orders.status, "completed")];
  if (range.fromDate) orderFilters.push(gte(orders.updatedAt, range.fromDate));
  if (range.toExclusiveDate) orderFilters.push(lt(orders.updatedAt, range.toExclusiveDate));
  const settlementFilters = [eq(settlements.businessId, businessId), eq(settlements.status, "paid")];
  if (range.fromDate) settlementFilters.push(gte(settlements.paidAt, range.fromDate));
  if (range.toExclusiveDate) settlementFilters.push(lt(settlements.paidAt, range.toExclusiveDate));

  const [[orderTotals], [settlementTotals]] = await Promise.all([
    db.select({
      grossSales: sql<number>`coalesce(sum(${orders.total}), 0)::bigint`.mapWith(Number),
      completedOrders: sql<number>`count(*)::int`,
    }).from(orders).where(and(...orderFilters)),
    db.select({
      netPaid: sql<number>`coalesce(sum(${settlements.netAmount}), 0)::bigint`.mapWith(Number),
      paidSettlements: sql<number>`count(*)::int`,
    }).from(settlements).where(and(...settlementFilters)),
  ]);

  return {
    from: range.from,
    to: range.to,
    grossSales: Math.max(0, Number(orderTotals?.grossSales ?? 0)),
    netPaid: Number(settlementTotals?.netPaid ?? 0),
    completedOrders: Number(orderTotals?.completedOrders ?? 0),
    paidSettlements: Number(settlementTotals?.paidSettlements ?? 0),
    currency: "INR",
  };
}
