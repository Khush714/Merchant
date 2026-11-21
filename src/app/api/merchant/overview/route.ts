import { and, desc, eq, gte, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, settlements } from "@/db/schema";
import { FEEDBACK_WINDOW_DAYS } from "@/lib/feedback";
import { applyRemoteRestaurant, parseRemoteOverview } from "@/lib/marketplace-payload";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse } from "@/lib/marketplace-bridge";
import { can } from "@/lib/roles";
import { ApiError, fail, recordAudit, requireBusiness } from "@/lib/server";
import { syncMarketplaceSettlements } from "@/lib/settlements";
import { logError } from "@/lib/telemetry";
import type { FeedbackSummary, Settlement, SettlementSync, SettlementTotals } from "@/lib/types";

export const dynamic = "force-dynamic";
const iso = (value: Date | null) => value ? value.toISOString() : null;
const NO_SETTLEMENT_ACCESS: SettlementSync = { linked: false, status: "idle", lastSyncedAt: null };
const EMPTY_TOTALS: SettlementTotals = { count: 0, gross: 0, fees: 0, refunds: 0, adjustments: 0, net: 0 };

function settlementDto(row: typeof settlements.$inferSelect): Settlement {
  return {
    id: row.id,
    externalId: row.externalId,
    marketplaceOrderId: row.marketplaceOrderId,
    orderNumber: row.orderNumber,
    netAmount: row.netAmount,
    grossAmount: row.grossAmount,
    commissionAmount: row.commissionAmount,
    refundAmount: row.refundAmount,
    adjustmentAmount: row.adjustmentAmount,
    currency: row.currency,
    status: row.status as Settlement["status"],
    reference: row.reference,
    paidAt: iso(row.paidAt),
    sourceUpdatedAt: iso(row.sourceUpdatedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

async function savedSettlements(businessId: string) {
  const rows = await db.select().from(settlements)
    .where(eq(settlements.businessId, businessId))
    .orderBy(desc(settlements.sourceUpdatedAt), desc(settlements.createdAt))
    .limit(50);
  return rows.map(settlementDto);
}

/** Aggregate every saved paid settlement so the KPI is not capped by the 50-row preview list. */
async function savedTotals(businessId: string): Promise<SettlementTotals> {
  const [row] = await db.select({
    count: sql<number>`count(*)::int`,
    gross: sql<number>`coalesce(sum(${settlements.grossAmount}), 0)`.mapWith(Number),
    fees: sql<number>`coalesce(sum(${settlements.commissionAmount}), 0)`.mapWith(Number),
    refunds: sql<number>`coalesce(sum(${settlements.refundAmount}), 0)`.mapWith(Number),
    adjustments: sql<number>`coalesce(sum(${settlements.adjustmentAmount}), 0)`.mapWith(Number),
    net: sql<number>`coalesce(sum(${settlements.netAmount}), 0)`.mapWith(Number),
  }).from(settlements).where(and(eq(settlements.businessId, businessId), eq(settlements.status, "paid")));
  return row ?? EMPTY_TOTALS;
}

export async function GET(request: NextRequest) {
  try {
    const { business, role } = await requireBusiness("overview.read");
    const canSeeSettlements = can(role, "settlements.read");
    const link = await getMarketplaceLink(business.id);
    const lastSyncedAt = iso(link?.settlementsSyncedAt ?? null);
    let settlementRows: Settlement[] = [];
    let totals: SettlementTotals = EMPTY_TOTALS;
    let settlementSync: SettlementSync = canSeeSettlements
      ? { linked: Boolean(link), status: "idle", lastSyncedAt }
      : NO_SETTLEMENT_ACCESS;

    if (link) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/overview");
      const parsed = parseMarketplaceResponse(remote, parseRemoteOverview);
      const mappedBusiness = applyRemoteRestaurant(business, parsed.restaurant);

      if (canSeeSettlements) {
        try {
          const result = await syncMarketplaceSettlements(business.id);
          if (result.throttled) {
            settlementSync = { linked: true, status: "throttled", lastSyncedAt: iso(result.lastSyncedAt), message: "Settlements were refreshed recently. Try again in a moment.", canRetry: true };
          } else if (result.truncated) {
            settlementSync = { linked: true, status: "truncated", lastSyncedAt: iso(result.lastSyncedAt), message: "Showing the newest 2,000 payouts. Older records remain in Marketplace.", canRetry: false };
          } else {
            settlementSync = { linked: true, status: "synced", lastSyncedAt: iso(result.lastSyncedAt) };
          }
          if (!result.throttled) {
            await recordAudit({ request, event: "settlement.sync", outcome: "success", businessId: business.id, detail: { source: "overview", received: result.received, applied: result.applied, truncated: result.truncated } });
          }
        } catch (error) {
          logError("settlement.sync_failed", error, { source: "overview" });
          await recordAudit({ request, event: "settlement.sync", outcome: "failure", businessId: business.id, detail: { source: "overview", reason: error instanceof ApiError ? error.message : "sync_failed" } });
          settlementSync = { linked: true, status: "error", lastSyncedAt, message: "Settlement records couldn’t be refreshed. Showing the last saved records.", canRetry: true };
        }
        settlementRows = await savedSettlements(business.id);
        totals = await savedTotals(business.id);
      }

      return NextResponse.json({
        business: mappedBusiness,
        overview: { ...parsed.overview, settlements: settlementRows, settlementSync, settlementTotals: totals },
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const start = new Date(`${date}T00:00:00+05:30`);
    const feedbackStart = new Date(Date.now() - FEEDBACK_WINDOW_DAYS * 86400000);
    const [groups, [today], [completed], localSettlements, localTotals, [latestNew], [feedbackRow]] = await Promise.all([
      db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.businessId, business.id)).groupBy(orders.status),
      db.select({ count: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.businessId, business.id), gte(orders.createdAt, start))),
      db.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${orders.total}), 0)`.mapWith(Number) }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "completed"), gte(orders.updatedAt, start))),
      canSeeSettlements ? savedSettlements(business.id) : Promise.resolve([] as Settlement[]),
      canSeeSettlements ? savedTotals(business.id) : Promise.resolve(EMPTY_TOTALS),
      db.select({ id: orders.id }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "new"))).orderBy(desc(orders.createdAt)).limit(1),
      db.select({
        average: sql<number | null>`avg(${orders.rating})::float`,
        count: sql<number>`count(*)::int`,
        bad: sql<number>`count(*) filter (where ${orders.rating} <= 2)::int`,
        pending: sql<number>`count(*) filter (where ${orders.merchantResponse} = '')::int`,
      }).from(orders).where(and(eq(orders.businessId, business.id), gte(orders.feedbackAt, feedbackStart))),
    ]);
    const counts: Record<string, number> = { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, rejected: 0, cancelled: 0 };
    groups.forEach((group) => { if (group.status in counts) counts[group.status] = group.count; });
    const feedback: FeedbackSummary = {
      available: true,
      windowDays: FEEDBACK_WINDOW_DAYS,
      averageRating: feedbackRow?.average == null ? null : Math.round(feedbackRow.average * 10) / 10,
      reviewCount: feedbackRow?.count ?? 0,
      badOrders: feedbackRow?.bad ?? 0,
      pendingReplies: feedbackRow?.pending ?? 0,
    };
    settlementRows = localSettlements;
    return NextResponse.json({
      business,
      overview: { counts, todaySales: completed.total, todayOrders: today.count, completedToday: completed.count, latestNewOrderId: latestNew?.id ?? null, settlements: settlementRows, settlementSync, settlementTotals: localTotals, feedback },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
