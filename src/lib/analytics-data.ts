import "server-only";

import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { loadRevenueSummary } from "@/lib/revenue-data";
import type { NormalizedRevenueRange } from "@/lib/revenue";
import type { AdvancedAnalytics } from "@/lib/types";
import { buildAdvancedAnalytics, marketplaceAnalytics, type AnalyticsOrderRow } from "./analytics-core";

/**
 * Single source for the Insights report. Totals always come from the Revenue loader so
 * paired and local outlets agree with the Revenue tab; row-level tables are local only.
 */
export async function loadAdvancedAnalytics(
  businessId: string,
  range: NormalizedRevenueRange,
): Promise<AdvancedAnalytics> {
  const [summary, paired] = await Promise.all([
    loadRevenueSummary(businessId, range),
    getMarketplaceLink(businessId),
  ]);
  if (paired) return marketplaceAnalytics(range, summary);

  const filters = [eq(orders.businessId, businessId)];
  if (range.fromDate) filters.push(gte(orders.createdAt, range.fromDate));
  if (range.toExclusiveDate) filters.push(lt(orders.createdAt, range.toExclusiveDate));
  const rows = await db.select({
    createdAt: orders.createdAt,
    status: orders.status,
    fulfilment: orders.fulfilment,
    paymentStatus: orders.paymentStatus,
    total: orders.total,
    discount: orders.discount,
    offerCode: orders.offerCode,
  }).from(orders).where(and(...filters));

  return buildAdvancedAnalytics(rows as AnalyticsOrderRow[], range, summary);
}
