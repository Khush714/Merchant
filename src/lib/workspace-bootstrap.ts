import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { businesses, orderItems, orders, settlements } from "@/db/schema";
import { FEEDBACK_WINDOW_DAYS } from "@/lib/feedback";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse, parseRemoteOrders } from "@/lib/marketplace-bridge";
import { applyRemoteRestaurant, parseRemoteOverview } from "@/lib/marketplace-payload";
import { can, type AppRole } from "@/lib/roles";
import { ApiError, businessForUser, businessesForUser, currentUser, recordAudit, requireBusiness, sessionContext, verificationRequired } from "@/lib/server";
import { syncMarketplaceSettlements } from "@/lib/settlements";
import { logError } from "@/lib/telemetry";
import type { AuthResponse, BusinessOption, FeedbackSummary, Order, Overview, Settlement, SettlementSync } from "@/lib/types";

type BusinessRow = typeof businesses.$inferSelect;

const iso = (value: Date | null) => value ? value.toISOString() : null;
const NO_SETTLEMENT_ACCESS: SettlementSync = { linked: false, status: "idle", lastSyncedAt: null };
const statuses = ["new", "accepted", "preparing", "ready", "out_for_delivery", "completed", "rejected", "cancelled"];
const toMarketplaceStatus: Record<string, string> = { new: "PLACED", accepted: "ACCEPTED", preparing: "PREPARING", ready: "READY", out_for_delivery: "OUT_FOR_DELIVERY", completed: "COMPLETED", rejected: "REJECTED", cancelled: "CANCELLED" };

function settlementDto(row: typeof settlements.$inferSelect): Settlement {
  return {
    id: row.id, externalId: row.externalId, marketplaceOrderId: row.marketplaceOrderId, orderNumber: row.orderNumber,
    netAmount: row.netAmount, grossAmount: row.grossAmount, commissionAmount: row.commissionAmount,
    refundAmount: row.refundAmount, adjustmentAmount: row.adjustmentAmount, currency: row.currency,
    status: row.status as Settlement["status"], reference: row.reference, paidAt: iso(row.paidAt),
    sourceUpdatedAt: iso(row.sourceUpdatedAt), createdAt: row.createdAt.toISOString(),
  };
}

async function savedSettlements(businessId: string) {
  const rows = await db.select().from(settlements)
    .where(eq(settlements.businessId, businessId))
    .orderBy(desc(settlements.sourceUpdatedAt), desc(settlements.createdAt))
    .limit(50);
  return rows.map(settlementDto);
}

async function withListingStatus<T extends { id: string; approvalStatus: string }>(business: T | undefined | null, linked?: boolean) {
  if (!business) return business;
  const isLinked = linked ?? Boolean(await getMarketplaceLink(business.id));
  return isLinked ? { ...business, approvalStatus: "approved" as const } : business;
}

/** Builds the auth payload for a user. A null active id means "use this account's first outlet". */
export async function listingFor(userId: string, activeBusinessId?: string | null) {
  const [active, available] = await Promise.all([
    businessForUser(userId, activeBusinessId),
    businessesForUser(userId),
  ]);
  const options: BusinessOption[] = await Promise.all(available.map(async ({ business, role }) => {
    const linked = Boolean(await getMarketplaceLink(business.id));
    return {
      id: business.id, name: business.name, type: business.type as BusinessOption["type"],
      approvalStatus: linked ? "approved" : business.approvalStatus as BusinessOption["approvalStatus"],
      isOpen: business.isOpen, role, linked,
    };
  }));
  const business = active
    ? await withListingStatus(active.business, options.find((option) => option.id === active.business.id)?.linked)
    : null;
  return { business, role: active?.role ?? null, businesses: options };
}

/** Shared by /api/merchant/overview and the server-rendered first paint. */
export async function loadOverviewData(business: BusinessRow, role: AppRole, request?: NextRequest, options: { skipSettlementSync?: boolean } = {}) {
  const canSeeSettlements = can(role, "settlements.read");
  const link = await getMarketplaceLink(business.id);
  const lastSyncedAt = iso(link?.settlementsSyncedAt ?? null);
  let settlementRows: Settlement[] = [];
  let settlementSync: SettlementSync = canSeeSettlements
    ? { linked: Boolean(link), status: "idle", lastSyncedAt }
    : NO_SETTLEMENT_ACCESS;

  if (link) {
    const remote = await marketplaceFetch(business.id, "/api/integration/merchant/overview");
    const parsed = parseMarketplaceResponse(remote, parseRemoteOverview);
    const mappedBusiness = applyRemoteRestaurant(business, parsed.restaurant);

    if (canSeeSettlements) {
      if (options.skipSettlementSync) {
        // First paint uses the last saved records; the client's normal /overview
        // refresh runs the bounded sync in the background after the page renders.
        settlementSync = { linked: true, status: "idle", lastSyncedAt };
      } else {
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
      }
      settlementRows = await savedSettlements(business.id);
    }

    return { business: mappedBusiness, overview: { ...parsed.overview, settlements: settlementRows, settlementSync } };
  }

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(`${date}T00:00:00+05:30`);
  const feedbackStart = new Date(Date.now() - FEEDBACK_WINDOW_DAYS * 86400000);
  const [groups, [today], [completed], localSettlements, [latestNew], [feedbackRow]] = await Promise.all([
    db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.businessId, business.id)).groupBy(orders.status),
    db.select({ count: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.businessId, business.id), gte(orders.createdAt, start))),
    db.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${orders.total}), 0)`.mapWith(Number) }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "completed"), gte(orders.updatedAt, start))),
    canSeeSettlements ? savedSettlements(business.id) : Promise.resolve([] as Settlement[]),
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
  return {
    business,
    overview: { counts, todaySales: completed.total, todayOrders: today.count, completedToday: completed.count, latestNewOrderId: latestNew?.id ?? null, settlements: localSettlements, settlementSync, feedback },
  };
}

/** Shared by /api/merchant/orders and the server-rendered first paint. */
export async function loadOrdersData(business: BusinessRow, params: URLSearchParams) {
  const status = params.get("status") || "active", search = (params.get("search") || "").trim().slice(0, 20);
  if (await getMarketplaceLink(business.id)) {
    const remoteStatus = status === "feedback" ? "all" : status === "new" ? "PLACED" : status === "cancelled" ? "cancelled" : status === "active" || status === "all" ? status : (toMarketplaceStatus[status] ?? status);
    const remoteParams = new URLSearchParams({ status: remoteStatus, page: String(Math.max(1, Math.min(1000, Number(params.get("page")) || 1))), limit: String(Math.max(1, Math.min(50, Number(params.get("limit")) || 20))) });
    if (search) remoteParams.set("search", search);
    const from = params.get("from"), to = params.get("to");
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) remoteParams.set("from", from);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) remoteParams.set("to", to);
    const remote = await marketplaceFetch(business.id, `/api/integration/merchant/orders?${remoteParams}`);
    const parsed = parseMarketplaceResponse(remote, (payload) => parseRemoteOrders(payload, business.id));
    const mapped = status === "feedback" ? parsed.orders.filter((order) => order.feedbackAt) : parsed.orders;
    return { orders: mapped, hasMore: parsed.hasMore, page: parsed.page };
  }
  const page = Math.max(1, Math.min(1000, Number(params.get("page")) || 1));
  const limit = Math.max(1, Math.min(50, Number(params.get("limit")) || 20));
  const filters: SQL[] = [eq(orders.businessId, business.id)];
  if (status === "active") filters.push(inArray(orders.status, ["new", "accepted", "preparing", "ready", "out_for_delivery"]));
  else if (status === "cancelled") filters.push(inArray(orders.status, ["cancelled", "rejected"]));
  else if (status === "feedback") filters.push(isNotNull(orders.feedbackAt));
  else if (status !== "all") { if (!statuses.includes(status)) throw new ApiError("Invalid status."); filters.push(eq(orders.status, status)); }
  if (search) filters.push(sql`${orders.orderNumber}::text LIKE ${`%${search.replace(/[^0-9]/g, "")}%`}`);
  const from = params.get("from"), to = params.get("to");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) filters.push(gte(orders.createdAt, new Date(`${from}T00:00:00+05:30`)));
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) filters.push(lt(orders.createdAt, new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000)));
  const rows = await db.select().from(orders).where(and(...filters)).orderBy(desc(orders.createdAt)).limit(limit + 1).offset((page - 1) * limit);
  const hasMore = rows.length > limit, selected = rows.slice(0, limit);
  const items = selected.length ? await db.select().from(orderItems).where(inArray(orderItems.orderId, selected.map((o) => o.id))) : [];
  const result = selected.map(({ idempotencyHash: _key, requestHash: _hash, ...order }) => ({ ...order, items: items.filter((item) => item.orderId === order.id) }));
  return { orders: result, hasMore, page };
}

export type WorkspaceBootstrap = {
  auth: AuthResponse;
  workspace: null | { overview: Overview; orders: Order[]; hasMore: boolean };
};

/** Runs once per page request so the first paint is real data instead of sample → zero → real. */
export async function getWorkspaceBootstrap(): Promise<WorkspaceBootstrap> {
  const user = await currentUser();
  const noAuth = {
    auth: { user: null, business: null, role: null, businesses: [], verificationRequired: verificationRequired() },
    workspace: null,
  } as unknown as WorkspaceBootstrap;
  if (!user) return noAuth;

  const context = await sessionContext();
  const [authPayload, active] = await Promise.all([
    listingFor(user.id, context?.activeBusinessId),
    businessForUser(user.id, context?.activeBusinessId),
  ]);
  const auth = JSON.parse(JSON.stringify({ user, ...authPayload, verificationRequired: verificationRequired() })) as WorkspaceBootstrap["auth"];

  let workspace: WorkspaceBootstrap["workspace"] = null;
  if (active && can(active.role, "overview.read")) {
    const [overviewResult, ordersResult] = await Promise.allSettled([
      loadOverviewData(active.business, active.role, undefined, { skipSettlementSync: true }),
      loadOrdersData(active.business, new URLSearchParams({ status: "active", page: "1", limit: "20" })),
    ]);
    if (overviewResult.status === "fulfilled") {
      // One failed read must not throw away the other; the client polls/retries.
      workspace = {
        overview: JSON.parse(JSON.stringify(overviewResult.value.overview)),
        orders: ordersResult.status === "fulfilled" ? JSON.parse(JSON.stringify(ordersResult.value.orders)) : [],
        hasMore: ordersResult.status === "fulfilled" ? ordersResult.value.hasMore : false,
      };
    }
  }
  return { auth, workspace };
}
