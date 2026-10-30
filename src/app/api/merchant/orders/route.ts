import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orderEvents, orderItems, orders } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError, fail, requireBusiness, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
const statuses = ["new", "accepted", "preparing", "ready", "completed", "rejected", "cancelled"];
const transitions: Record<string, string[]> = { new: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["completed"] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMarketplaceStatus: Record<string, string> = { new: "PLACED", accepted: "ACCEPTED", preparing: "PREPARING", ready: "READY", completed: "COMPLETED", rejected: "REJECTED", cancelled: "CANCELLED" };
const fromMarketplaceStatus: Record<string, string> = Object.fromEntries(Object.entries(toMarketplaceStatus).map(([local, remote]) => [remote, local]));
function mapMarketplaceOrder(order: any, businessId: string) {
  return {
    id: String(order.code), orderNumber: String(order.code), businessId,
    customerName: order.customerName || "Guest", customerNote: order.instructions || "",
    total: Number(order.totalCents ?? 0), status: fromMarketplaceStatus[order.status] ?? "new",
    fulfilment: String(order.fulfilment || "delivery").toLowerCase(), deliveryAddress: order.addressText || "",
    paymentStatus: String(order.paymentStatus || "unpaid").toLowerCase(),
    paymentMethod: order.paymentMethod === "cod" ? "cash on delivery" : String(order.paymentMethod || "online").toLowerCase(),
    prepMinutes: order.prepMinutes ?? null, rejectionReason: order.rejectionReason || "",
    createdAt: order.createdAt, updatedAt: order.statusUpdatedAt || order.createdAt,
    items: (Array.isArray(order.items) ? order.items : []).map((item: any, index: number) => {
      const quantity = Number(item.quantity || 1);
      const modifiers = Array.isArray(item.modifiers) ? item.modifiers.map((modifier: any) => ({
        name: String(modifier.name || "Option"), quantity: Number(modifier.quantity || 1), priceCents: Number(modifier.priceCents || 0),
      })) : [];
      const unitPrice = Number(item.priceCents ?? item.unitPrice ?? 0);
      const lineTotal = unitPrice * quantity + modifiers.reduce((sum: number, modifier: { priceCents: number; quantity: number }) => sum + modifier.priceCents * modifier.quantity, 0);
      return { id: `${order.code}-${index}`, name: String(item.name || "Item"), quantity, unitPrice, lineTotal, modifiers };
    }),
  };
}
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness();
    const p = request.nextUrl.searchParams, status = p.get("status") || "active", search = (p.get("search") || "").trim().slice(0, 20);
    if (await getMarketplaceLink(business.id)) {
      const remoteStatus = status === "new" ? "PLACED" : status === "cancelled" ? "cancelled" : status === "active" || status === "all" ? status : (toMarketplaceStatus[status] ?? status);
      const remoteParams = new URLSearchParams({ status: remoteStatus, page: String(Math.max(1, Math.min(1000, Number(p.get("page")) || 1))), limit: String(Math.max(1, Math.min(50, Number(p.get("limit")) || 20))) });
      if (search) remoteParams.set("search", search);
      const from = p.get("from"), to = p.get("to");
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) remoteParams.set("from", from);
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) remoteParams.set("to", to);
      const remote = await marketplaceFetch<any>(business.id, `/api/integration/merchant/orders?${remoteParams}`);
      const mapped = (remote.orders ?? []).map((order: any) => mapMarketplaceOrder(order, business.id));
      return NextResponse.json({ orders: mapped, hasMore: Boolean(remote.hasMore), page: remote.page ?? 1 });
    }
    const page = Math.max(1, Math.min(1000, Number(p.get("page")) || 1));
    const limit = Math.max(1, Math.min(50, Number(p.get("limit")) || 20));
    const filters: SQL[] = [eq(orders.businessId, business.id)];
    if (status === "active") filters.push(inArray(orders.status, ["new", "accepted", "preparing", "ready"]));
    else if (status === "cancelled") filters.push(inArray(orders.status, ["cancelled", "rejected"]));
    else if (status !== "all") { if (!statuses.includes(status)) throw new ApiError("Invalid status."); filters.push(eq(orders.status, status)); }
    if (search) filters.push(sql`${orders.orderNumber}::text LIKE ${`%${search.replace(/[^0-9]/g, "")}%`}`);
    const from = p.get("from"), to = p.get("to");
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) filters.push(gte(orders.createdAt, new Date(`${from}T00:00:00+05:30`)));
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) filters.push(lt(orders.createdAt, new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000)));
    const rows = await db.select().from(orders).where(and(...filters)).orderBy(desc(orders.createdAt)).limit(limit + 1).offset((page - 1) * limit);
    const hasMore = rows.length > limit, selected = rows.slice(0, limit);
    const items = selected.length ? await db.select().from(orderItems).where(inArray(orderItems.orderId, selected.map((o) => o.id))) : [];
    return NextResponse.json({ orders: selected.map(({ idempotencyHash: _key, requestHash: _hash, ...order }) => ({ ...order, items: items.filter((item) => item.orderId === order.id) })), hasMore, page });
  } catch (error) { return fail(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const { user, business } = await requireBusiness(); const body = await request.json();
    if (await getMarketplaceLink(business.id)) {
      const orderCode = typeof body.orderCode === "string" ? body.orderCode : typeof body.id === "string" ? body.id : "";
      const expectedStatus = typeof body.expectedStatus === "string" ? body.expectedStatus : "";
      const nextStatus = typeof body.nextStatus === "string" ? body.nextStatus : "";
      if (!orderCode || !toMarketplaceStatus[expectedStatus] || !toMarketplaceStatus[nextStatus] || !transitions[expectedStatus]?.includes(nextStatus)) throw new ApiError("Invalid order transition.");
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/orders", {
        method: "PATCH",
        body: JSON.stringify({ orderCode, expectedStatus: toMarketplaceStatus[expectedStatus], nextStatus: toMarketplaceStatus[nextStatus], ...(body.prepMinutes === undefined ? {} : { prepMinutes: Number(body.prepMinutes) }), ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }),
      });
      return NextResponse.json({ order: remote.order ? { ...remote.order, id: String(remote.order.code), status: fromMarketplaceStatus[remote.order.status] ?? nextStatus } : { id: orderCode, status: nextStatus } });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id) || typeof body.expectedStatus !== "string" || typeof body.nextStatus !== "string" || !transitions[body.expectedStatus]?.includes(body.nextStatus)) throw new ApiError("Invalid order transition.");
    const reason = textValue(body.reason, 250);
    if (body.nextStatus === "rejected" && !reason) throw new ApiError("Please provide a reason for rejecting this order.");
    const prepMinutes = Number(body.prepMinutes);
    if (body.nextStatus === "accepted" && (!Number.isInteger(prepMinutes) || prepMinutes < 5 || prepMinutes > 180)) throw new ApiError("Choose a preparation time between 5 and 180 minutes.");
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(orders).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id))).limit(1);
      if (!current) throw new ApiError("Order not found.", 404);
      if (current.status !== body.expectedStatus) throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
      if (body.nextStatus === "completed" && current.fulfilment !== "pickup") throw new ApiError("Delivery completion must be confirmed by the delivery service.", 409);
      const [result] = await tx.update(orders).set({ status: body.nextStatus, prepMinutes: body.nextStatus === "accepted" ? prepMinutes : current.prepMinutes, rejectionReason: body.nextStatus === "rejected" ? reason : current.rejectionReason, updatedAt: new Date() }).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id), eq(orders.status, body.expectedStatus))).returning();
      if (!result) throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
      await tx.insert(orderEvents).values({ orderId: result.id, actorId: user.id, fromStatus: body.expectedStatus, toStatus: body.nextStatus, reason });
      return result;
    });
    return NextResponse.json({ order: updated });
  } catch (error) { return fail(error); }
}
