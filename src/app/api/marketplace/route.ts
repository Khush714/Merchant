import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, businessMarketplaceLinks, menuItems, offers, orderEvents, orderItems, orders } from "@/db/schema";
import { feedbackDto } from "@/lib/feedback";
import { calculateDiscount, isOfferLive, publicOfferDto } from "@/lib/offers";
import { ApiError, BODY_LIMITS, fail, rateLimit, readJson, sameOrigin, sha256, textValue, withinOperatingHours } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: NextRequest) {
  try {
    await rateLimit(request, "marketplace-read", 120);
    const p = request.nextUrl.searchParams, orderId = p.get("orderId"), token = p.get("token"), businessId = p.get("businessId");
    if (orderId && token) {
      if (!uuid.test(orderId) || token.length < 32 || token.length > 128) throw new ApiError("Order not found.", 404);
      const [order] = await db.select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, total: orders.total, fulfilment: orders.fulfilment, paymentStatus: orders.paymentStatus, prepMinutes: orders.prepMinutes, rejectionReason: orders.rejectionReason, discount: orders.discount, offerCode: orders.offerCode, rating: orders.rating, review: orders.review, feedbackAt: orders.feedbackAt, merchantResponse: orders.merchantResponse, merchantRespondedAt: orders.merchantRespondedAt, createdAt: orders.createdAt }).from(orders).where(and(eq(orders.id, orderId), eq(orders.idempotencyHash, sha256(token)))).limit(1);
      if (!order) throw new ApiError("Order not found.", 404);
      const items = await db.select({ id: orderItems.id, name: orderItems.name, quantity: orderItems.quantity, unitPrice: orderItems.unitPrice }).from(orderItems).where(eq(orderItems.orderId, order.id));
      const { rating: _rating, review: _review, feedbackAt: _feedbackAt, merchantResponse: _response, merchantRespondedAt: _respondedAt, ...publicOrder } = order;
      return NextResponse.json({ order: { ...publicOrder, items, feedback: feedbackDto(order) } });
    }
    if (businessId) {
      if (!uuid.test(businessId)) throw new ApiError("Business not found.", 404);
      const [business] = await db.select().from(businesses).where(and(eq(businesses.id, businessId), eq(businesses.approvalStatus, "approved"), eq(businesses.isOpen, true))).limit(1);
      if (!business || !withinOperatingHours(business)) throw new ApiError("This business is not currently accepting orders.", 404);
      const items = await db.select().from(menuItems).where(and(eq(menuItems.businessId, business.id), eq(menuItems.available, true), eq(menuItems.archived, false))).orderBy(asc(menuItems.category), asc(menuItems.name)).limit(500);
      const rows = await db.select({ offer: offers, redemptions: sql<number>`count(${orders.id})::int` })
        .from(offers)
        .leftJoin(orders, eq(orders.offerId, offers.id))
        .where(and(eq(offers.businessId, business.id), eq(offers.active, true), eq(offers.archived, false)))
        .groupBy(offers.id).orderBy(asc(offers.createdAt)).limit(50);
      const visibleOffers = rows.filter((row) => isOfferLive(row.offer) && (row.offer.usageLimit === null || row.redemptions < row.offer.usageLimit)).map((row) => publicOfferDto(row.offer));
      return NextResponse.json({ business: { id: business.id, name: business.name, category: business.category, address: business.address, pickupEnabled: business.pickupEnabled, deliveryEnabled: business.deliveryEnabled }, items, offers: visibleOffers });
    }
    const rows = await db.select().from(businesses).where(and(eq(businesses.approvalStatus, "approved"), eq(businesses.isOpen, true))).orderBy(asc(businesses.name)).limit(100);
    return NextResponse.json({ businesses: rows.filter(withinOperatingHours).map((b) => ({ id: b.id, name: b.name, category: b.category, address: b.address, type: b.type })) });
  } catch (error) { return fail(error, request); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); await rateLimit(request, "marketplace-order", 30);
    const body = await readJson(request, BODY_LIMITS.marketplace);
    const businessId = textValue(body.businessId, 50), token = textValue(body.idempotencyKey, 128), customerName = textValue(body.customerName, 100) || "Guest", customerNote = textValue(body.customerNote, 500), fulfilment = textValue(body.fulfilment, 20), deliveryAddress = textValue(body.deliveryAddress, 300), offerCode = textValue(body.offerCode, 40).toUpperCase();
    if (!uuid.test(businessId) || token.length < 32 || !/^[a-zA-Z0-9-]+$/.test(token) || !["pickup", "delivery"].includes(fulfilment) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw new ApiError("Please check your order and try again.");
    const [marketplaceLink] = await db.select({ id: businessMarketplaceLinks.id }).from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
    if (marketplaceLink) throw new ApiError("This business is connected to Savour Marketplace. Place customer orders through the Marketplace so the merchant receives the single canonical order.", 409);
    if (fulfilment === "delivery" && !deliveryAddress) throw new ApiError("A delivery address is required.");
    const lines: { id: string; quantity: number }[] = body.items.map((line: { id?: unknown; quantity?: unknown }) => ({ id: textValue(line.id, 50), quantity: Number(line.quantity) }));
    if (lines.some((line) => !uuid.test(line.id) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) || new Set(lines.map((line) => line.id)).size !== lines.length) throw new ApiError("Invalid order items.");
    lines.sort((a, b) => a.id.localeCompare(b.id));
    const idempotencyHash = sha256(token), requestHash = sha256(JSON.stringify({ businessId, customerName, customerNote, fulfilment, deliveryAddress, lines, offerCode }));
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
      const subtotal = snapshots.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      if (!Number.isSafeInteger(subtotal) || subtotal > 2_147_483_647) throw new ApiError("Order total is too large. Please reduce the quantity.");
      let appliedOffer: typeof offers.$inferSelect | null = null;
      let discount = 0;
      if (offerCode) {
        // Lock the offer so a usage-limit change or archive cannot race this redemption.
        const [candidate] = await tx.select().from(offers).where(and(eq(offers.businessId, businessId), eq(offers.code, offerCode), eq(offers.active, true), eq(offers.archived, false))).limit(1).for("update");
        if (!candidate) throw new ApiError("That offer code isn’t available for this business.", 404);
        if (!isOfferLive(candidate)) throw new ApiError("This offer is no longer running.", 409);
        if (subtotal < candidate.minOrder) throw new ApiError(`Add ₹${Math.ceil((candidate.minOrder - subtotal) / 100)} more to use ${candidate.code}.`, 409);
        if (candidate.usageLimit !== null) {
          const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.offerId, candidate.id));
          if (count >= candidate.usageLimit) throw new ApiError("This offer has reached its usage limit.", 409);
        }
        discount = calculateDiscount(candidate, subtotal);
        appliedOffer = candidate;
      }
      const total = subtotal - discount;
      const [created] = await tx.insert(orders).values({ businessId, customerName, customerNote, fulfilment, deliveryAddress, total, offerId: appliedOffer?.id ?? null, offerCode: appliedOffer?.code ?? "", discount, idempotencyHash, requestHash }).returning();
      await tx.insert(orderItems).values(snapshots.map((item) => ({ ...item, orderId: created.id })));
      await tx.insert(orderEvents).values({ orderId: created.id, fromStatus: "", toStatus: "new" });
      return created;
    });
    return NextResponse.json({ order: { id: order.id, orderNumber: order.orderNumber, status: order.status, total: order.total, discount: order.discount, offerCode: order.offerCode }, token }, { status: 201 });
  } catch (error) { return fail(error, request); }
}
