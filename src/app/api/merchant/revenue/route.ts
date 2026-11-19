import { and, eq, gte, lt, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, settlements } from "@/db/schema";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteRevenue,
} from "@/lib/marketplace-bridge";
import { normalizeRevenueRange } from "@/lib/revenue";
import { ApiError, fail, requireBusiness } from "@/lib/server";
import type { RevenueSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Revenue is Marketplace-owned for paired listings; unpaired rows stay local. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const params = request.nextUrl.searchParams;
    const range = normalizeRevenueRange(params.get("from"), params.get("to"));
    if (!range) throw new ApiError("Choose a valid start and end date.");

    if (await getMarketplaceLink(business.id)) {
      const remoteParams = new URLSearchParams();
      if (range.from && range.to) {
        remoteParams.set("from", range.from);
        remoteParams.set("to", range.to);
      }
      const suffix = remoteParams.toString();
      const remote = await marketplaceFetch(
        business.id,
        `/api/integration/merchant/revenue${suffix ? `?${suffix}` : ""}`,
      );
      const revenue = parseMarketplaceResponse(remote, parseRemoteRevenue);
      return NextResponse.json({ revenue }, { headers: { "Cache-Control": "no-store" } });
    }

    const orderFilters = [eq(orders.businessId, business.id), eq(orders.status, "completed")];
    if (range.fromDate) orderFilters.push(gte(orders.updatedAt, range.fromDate));
    if (range.toExclusiveDate) orderFilters.push(lt(orders.updatedAt, range.toExclusiveDate));
    const settlementFilters = [eq(settlements.businessId, business.id), eq(settlements.status, "paid")];
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

    const revenue: RevenueSummary = {
      from: range.from,
      to: range.to,
      grossSales: Math.max(0, Number(orderTotals?.grossSales ?? 0)),
      netPaid: Number(settlementTotals?.netPaid ?? 0),
      completedOrders: Number(orderTotals?.completedOrders ?? 0),
      paidSettlements: Number(settlementTotals?.paidSettlements ?? 0),
      currency: "INR",
    };
    return NextResponse.json({ revenue }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
