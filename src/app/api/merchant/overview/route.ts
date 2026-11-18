import { and, desc, eq, gte, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, settlements } from "@/db/schema";
import { FEEDBACK_WINDOW_DAYS, emptyFeedbackSummary } from "@/lib/feedback";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError, fail, recordAudit, requireBusiness } from "@/lib/server";
import { syncMarketplaceSettlements } from "@/lib/settlements";
import { logError } from "@/lib/telemetry";
import type { FeedbackSummary, Settlement, SettlementSync } from "@/lib/types";

export const dynamic = "force-dynamic";
const iso = (value: Date | null) => value ? value.toISOString() : null;
const numberValue = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
function remoteFeedbackSummary(value: unknown): FeedbackSummary {
  if (!value || typeof value !== "object") return emptyFeedbackSummary(false);
  const row = value as Record<string, unknown>;
  const average = numberValue(row.averageRating, -1);
  return {
    available: true,
    windowDays: numberValue(row.windowDays, FEEDBACK_WINDOW_DAYS),
    averageRating: average < 0 ? null : Math.round(average * 10) / 10,
    reviewCount: numberValue(row.reviewCount),
    badOrders: numberValue(row.badOrders),
    pendingReplies: numberValue(row.pendingReplies),
  };
}

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

export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("overview.read");
    const link = await getMarketplaceLink(business.id);
    let settlementSync: SettlementSync = { linked: Boolean(link), status: "idle", lastSyncedAt: iso(link?.settlementsSyncedAt ?? null) };

    if (link) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/overview");
      const restaurant = remote.restaurant ?? {};
      const mappedBusiness = {
        ...business,
        name: restaurant.name || business.name,
        // A linked business already has a live Marketplace listing; the local
        // approval flag is a legacy setup field and must not mark it as pending.
        approvalStatus: "approved",
        isOpen: Boolean(restaurant.isActive),
        hoursEnabled: Boolean(restaurant.merchantHoursEnabled),
        opensAt: restaurant.merchantOpensAt || business.opensAt,
        closesAt: restaurant.merchantClosesAt || business.closesAt,
        pickupEnabled: restaurant.merchantPickupEnabled ?? business.pickupEnabled,
        deliveryEnabled: restaurant.merchantDeliveryEnabled ?? business.deliveryEnabled,
      };
      try {
        const result = await syncMarketplaceSettlements(business.id);
        settlementSync = { linked: true, status: "synced", lastSyncedAt: iso(result.lastSyncedAt) };
        if (!result.throttled) {
          await recordAudit({ request, event: "settlement.sync", outcome: "success", businessId: business.id, detail: { source: "overview", received: result.received, applied: result.applied } });
        }
      } catch (error) {
        logError("settlement.sync_failed", error, { source: "overview" });
        await recordAudit({ request, event: "settlement.sync", outcome: "failure", businessId: business.id, detail: { source: "overview", reason: error instanceof ApiError ? error.message : "sync_failed" } });
        settlementSync = { linked: true, status: "error", lastSyncedAt: iso(link.settlementsSyncedAt), message: "Settlement records couldn’t be refreshed. Showing the last saved records." };
      }
      const overview = remote.overview ?? {};
      return NextResponse.json({ business: mappedBusiness, overview: {
        counts: overview.counts ?? { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, rejected: 0, cancelled: 0 },
        todaySales: Number(overview.todaySales ?? 0), todayOrders: Number(overview.todayOrders ?? 0),
        completedToday: Number(overview.completedToday ?? 0), latestNewOrderId: overview.latestNewOrderId ?? null,
        settlements: await savedSettlements(business.id), settlementSync,
        feedback: remoteFeedbackSummary(overview.feedback),
      } }, { headers: { "Cache-Control": "no-store" } });
    }

    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const start = new Date(`${date}T00:00:00+05:30`);
    const feedbackStart = new Date(Date.now() - FEEDBACK_WINDOW_DAYS * 86400000);
    const [groups, [today], [completed], settlementRows, [latestNew], [feedbackRow]] = await Promise.all([
      db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.businessId, business.id)).groupBy(orders.status),
      db.select({ count: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.businessId, business.id), gte(orders.createdAt, start))),
      db.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${orders.total}), 0)`.mapWith(Number) }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "completed"), gte(orders.updatedAt, start))),
      savedSettlements(business.id),
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
    return NextResponse.json({ business, overview: { counts, todaySales: completed.total, todayOrders: today.count, completedToday: completed.count, latestNewOrderId: latestNew?.id ?? null, settlements: settlementRows, settlementSync, feedback } });
  } catch (error) { return fail(error, request); }
}
