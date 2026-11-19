import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders } from "@/db/schema";
import { localItemAnalytics } from "@/lib/item-analytics-core";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteItemAnalytics,
} from "@/lib/marketplace-bridge";
import type { NormalizedRevenueRange } from "@/lib/revenue";
import type { ItemAnalytics } from "@/lib/types";

/**
 * One source for the item sales report. Paired listings are calculated by
 * Marketplace; unpaired listings roll up their own completed order lines.
 */
export async function loadItemAnalytics(
  businessId: string,
  range: NormalizedRevenueRange,
): Promise<ItemAnalytics> {
  if (await getMarketplaceLink(businessId)) {
    const params = new URLSearchParams();
    if (range.from && range.to) {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    const suffix = params.toString();
    const remote = await marketplaceFetch(
      businessId,
      `/api/integration/merchant/item-analytics${suffix ? `?${suffix}` : ""}`,
    );
    return parseMarketplaceResponse(remote, parseRemoteItemAnalytics);
  }

  const filters = [eq(orders.businessId, businessId), eq(orders.status, "completed")];
  if (range.fromDate) filters.push(gte(orders.updatedAt, range.fromDate));
  if (range.toExclusiveDate) filters.push(lt(orders.updatedAt, range.toExclusiveDate));
  const rows = await db.select({
    orderId: orders.id,
    itemId: orderItems.menuItemId,
    name: orderItems.name,
    quantity: orderItems.quantity,
    unitPrice: orderItems.unitPrice,
    at: orders.updatedAt,
  }).from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...filters));

  return localItemAnalytics(rows, range);
}
