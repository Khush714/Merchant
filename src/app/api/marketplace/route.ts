import { and, asc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, businessMarketplaceLinks, menuItems, orderEvents, orderItems, orders } from "@/db/schema";
import { ApiError, fail, rateLimit, sameOrigin, sha256, textValue, withinOperatingHours } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: NextRequest) {
  try {
    rateLimit(request, "marketplace-read", 120);
    const p = request.nextUrl.searchParams, orderId = p.get("orderId"), token = p.get("token"), businessId = p.get("businessId");
    if (orderId && token) {
      if (!uuid.test(orderId) || token.length < 32 || token.length > 128) throw new ApiError("Order not found.", 404);
      const [order] = await db.select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, total: orders.total, fulfilment: orders.fulfilment, paymentStatus: orders.paymentStatus, prepMinutes: orders.prepMinutes, rejectionReason: orders.rejectionReason, createdAt: orders.createdAt }).from(orders).where(and(eq(orders.id, orderId), eq(orders.idempotencyHash, sha256(token)))).limit(1);
      if (!order) throw new ApiError("Order not found.", 404);
      const items = await db.select({ id: orderItems.id, name: orderItems.name, quantity: orderItems.quantity, unitPrice: orderItems.unitPrice }).from(orderItems).where(eq(orderItems.orderId, order.id));
      return NextResponse.json({ order: { ...order, items } });
    }
    if (businessId) {
      if (!uuid.test(businessId)) throw new ApiError("Business not found.", 404);
      const [business] = await db.select().from(businesses).where(and(eq(businesses.id, businessId), eq(businesses.approvalStatus, "approved"), eq(businesses.isOpen, true))).limit(1);
      if (!business || !withinOperatingHours(business)) throw new ApiError("This business is not currently accepting orders.", 404);
      const items = await db.select().from(menuItems).where(and(eq(menuItems.businessId, business.id), eq(menuItems.available, true), eq(menuItems.archived, false))).orderBy(asc(menuItems.category), asc(menuItems.name)).limit(500);
      return NextResponse.json({ business: { id: business.id, name: business.name, category: business.category, address: business.address, pickupEnabled: business.pickupEnabled, deliveryEnabled: business.deliveryEnabled }, items });
    }
    const rows = await db.select().from(businesses).where(and(eq(businesses.approvalStatus, "approved"), eq(businesses.isOpen, true))).orderBy(asc(businesses.name)).limit(100);
    return NextResponse.json({ businesses: rows.filter(withinOperatingHours).map((b) => ({ id: b.id, name: b.name, category: b.category, address: b.address, type: b.type })) });
  } catch (error) { return fail(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); rateLimit(request, "marketplace-order", 30);
    const body = await request.json();
    const businessId = textValue(body.businessId, 50), token = textValue(body.idempotencyKey, 128), customerName = textValue(body.customerName, 100) || "Guest", customerNote = textValue(body.customerNote, 500), fulfilment = textValue(body.fulfilment, 20), deliveryAddress = textValue(body.deliveryAddress, 300);
    if (!uuid.test(businessId) || token.length < 32 || !/^[a-zA-Z0-9-]+$/.test(token) || !["pickup", "delivery"].includes(fulfilment) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw new ApiError("Please check your order and try again.");
    const [marketplaceLink] = await db.select({ id: businessMarketplaceLinks.id }).from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
    if (marketplaceLink) throw new ApiError("This business is connected to Savour Marketplace. Place customer orders through the Marketplace so the merchant receives the single canonical order.", 409);
    if (fulfilment === "delivery" && !deliveryAddress) throw new ApiError("A delivery address is required.");
    const lines: { id: string; quantity: number }[] = body.items.map((line: { id?: unknown; quantity?: unknown }) => ({ id: textValue(line.id, 50), quantity: Number(line.quantity) }));
    if (lines.some((line) => !uuid.test(line.id) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) || new Set(lines.map((line) => line.id)).size !== lines.length) throw new ApiError("Invalid order items.");
    lines.sort((a, b) => a.id.localeCompare(b.id));
    const idempotencyHash = sha256(token), requestHash = sha256(JSON.stringify({ businessId, customerName, customerNote, fulfilment, deliveryAddress, lines }));
    const order = await db.transaction(async (tx) => {
      const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
      if (!business) throw new ApiError("Business not found.", 404);
      const [existing] = await tx.select().from(orders).where(and(eq(orders.businessId, businessId), eq(orders.idempotencyHash, idempotencyHash))).limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ApiError("This order key was already used for a different order.", 409);
        return existing;
      }
      if (business.approvalStatus !== "approved" || !business.isOpen || !withinOperatingHours(business)) throw new ApiError("This business is not currently accepting orders.", 409);
      if ((fulfilment === "pickup" && !business.pickupEnabled) || (fulfilment === "delivery" && !business.deliveryEnabled)) throw new ApiError("This fulfilment method is not available.", 409);
      const items = await tx.select().from(menuItems).where(and(eq(menuItems.businessId, business.id), inArray(menuItems.id, lines.map((line) => line.id)), eq(menuItems.available, true), eq(menuItems.archived, false))).for("update");
      if (items.length !== lines.length) throw new ApiError("One or more items are no longer available. Refresh the menu.", 409);
      const snapshots = lines.map((line) => { const item = items.find((i) => i.id === line.id)!; return { menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: line.quantity }; });
      const total = snapshots.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      if (!Number.isSafeInteger(total) || total > 2_147_483_647) throw new ApiError("Order total is too large. Please reduce the quantity.");
      const [created] = await tx.insert(orders).values({ businessId, customerName, customerNote, fulfilment, deliveryAddress, total, idempotencyHash, requestHash }).returning();
      await tx.insert(orderItems).values(snapshots.map((item) => ({ ...item, orderId: created.id })));
      await tx.insert(orderEvents).values({ orderId: created.id, fromStatus: "", toStatus: "new" });
      return created;
    });
    return NextResponse.json({ order: { id: order.id, orderNumber: order.orderNumber, status: order.status, total: order.total }, token }, { status: 201 });
  } catch (error) { return fail(error); }
}
