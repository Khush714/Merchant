import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orderEvents, orderItems, orders } from "@/db/schema";
import { dispatchCourierAssignment } from "@/lib/courier-dispatch";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteOrderMutation,
} from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, sameOrigin, textValue } from "@/lib/server";
import type { OrderStatus } from "@/lib/types";
import { loadOrdersData } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";
const transitions: Record<string, string[]> = { new: ["accepted", "rejected"], accepted: ["preparing"], preparing: ["ready"], ready: ["out_for_delivery", "completed"], out_for_delivery: ["completed"] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMarketplaceStatus: Record<string, string> = { new: "PLACED", accepted: "ACCEPTED", preparing: "PREPARING", ready: "READY", out_for_delivery: "OUT_FOR_DELIVERY", completed: "COMPLETED", rejected: "REJECTED", cancelled: "CANCELLED" };
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("orders.read");
    return NextResponse.json(await loadOrdersData(business, request.nextUrl.searchParams));
  } catch (error) { return fail(error, request); }
}
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const { user, business } = await requireBusiness("orders.write"); const body = await readJson(request, BODY_LIMITS.orders);
    if (body.fulfilment !== undefined) {
      const fulfilment = body.fulfilment;
      if (fulfilment !== "pickup" && fulfilment !== "delivery") throw new ApiError("Choose pickup or delivery.");
      const addressText = textValue(body.addressText, 500);
      if (await getMarketplaceLink(business.id)) {
        const orderCode = typeof body.orderCode === "string" ? body.orderCode : typeof body.id === "string" ? body.id : "";
        if (!orderCode) throw new ApiError("Order not found.", 404);
        const remote = await marketplaceFetch(business.id, "/api/integration/merchant/orders", {
          method: "PATCH",
          body: JSON.stringify({ orderCode, fulfilment, ...(addressText ? { addressText } : {}) }),
        });
        const order = parseMarketplaceResponse(remote, (payload) => parseRemoteOrderMutation(payload, { id: orderCode, fulfilment, addressText }));
        return NextResponse.json({ order });
      }
      if (typeof body.id !== "string" || !uuid.test(body.id)) throw new ApiError("Order not found.", 404);
      const updated = await db.transaction(async (tx) => {
        // Lock the order row so a simultaneous status transition cannot make these checks stale.
        const [current] = await tx.select().from(orders).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id))).limit(1).for("update");
        if (!current) throw new ApiError("Order not found.", 404);
        if (["completed", "rejected", "cancelled"].includes(current.status)) throw new ApiError("This order is closed and its fulfilment can no longer be changed.", 409);
        if (current.status === "out_for_delivery" && fulfilment === "pickup") throw new ApiError("This delivery is already with the rider and can no longer be changed to pickup.", 409);
        if (fulfilment === "pickup" && !business.pickupEnabled) throw new ApiError("Pickup is turned off in your business settings.", 409);
        if (fulfilment === "delivery" && !business.deliveryEnabled) throw new ApiError("Delivery is turned off in your business settings.", 409);
        const nextAddress = addressText || current.deliveryAddress;
        if (fulfilment === "delivery" && !nextAddress.trim()) throw new ApiError("Add a delivery address before switching to delivery.");
        if (fulfilment === current.fulfilment && !addressText) return current;
        const [result] = await tx.update(orders).set({
          fulfilment,
          ...(fulfilment === "delivery" ? { deliveryAddress: nextAddress } : {}),
          updatedAt: new Date(),
        }).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id), eq(orders.status, current.status), eq(orders.fulfilment, current.fulfilment))).returning();
        if (!result) throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
        await tx.insert(orderEvents).values({
          orderId: result.id, actorId: user.id, fromStatus: current.status, toStatus: current.status,
          reason: fulfilment === current.fulfilment ? "Delivery address updated by merchant" : `Fulfilment changed from ${current.fulfilment} to ${fulfilment} by merchant`,
        });
        return result;
      });
      return NextResponse.json({ order: updated });
    }
    if (await getMarketplaceLink(business.id)) {
      const orderCode = typeof body.orderCode === "string" ? body.orderCode : typeof body.id === "string" ? body.id : "";
      const expectedStatus = typeof body.expectedStatus === "string" ? body.expectedStatus : "";
      const nextStatus = typeof body.nextStatus === "string" ? body.nextStatus : "";
      if (!orderCode || !toMarketplaceStatus[expectedStatus] || !toMarketplaceStatus[nextStatus] || !transitions[expectedStatus]?.includes(nextStatus)) throw new ApiError("Invalid order transition.");
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/orders", {
        method: "PATCH",
        body: JSON.stringify({ orderCode, expectedStatus: toMarketplaceStatus[expectedStatus], nextStatus: toMarketplaceStatus[nextStatus], ...(body.prepMinutes === undefined ? {} : { prepMinutes: Number(body.prepMinutes) }), ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }),
      });
      const order = parseMarketplaceResponse(remote, (payload) => parseRemoteOrderMutation(payload, { id: orderCode, status: nextStatus as OrderStatus }));
      return NextResponse.json({ order });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id) || typeof body.expectedStatus !== "string" || typeof body.nextStatus !== "string" || !transitions[body.expectedStatus]?.includes(body.nextStatus)) throw new ApiError("Invalid order transition.");
    const requestedStatus = body.nextStatus as OrderStatus;
    const reason = textValue(body.reason, 250);
    if (requestedStatus === "rejected" && !reason) throw new ApiError("Please provide a reason for rejecting this order.");
    const prepMinutes = Number(body.prepMinutes);
    if (requestedStatus === "accepted" && (!Number.isInteger(prepMinutes) || prepMinutes < 5 || prepMinutes > 180)) throw new ApiError("Choose a preparation time between 5 and 180 minutes.");
    const updated = await db.transaction(async (tx) => {
      // Lock the order row before validating the transition. Without this, a concurrent
      // fulfilment change could make the fulfilment checks below operate on stale data.
      const [current] = await tx.select().from(orders).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id))).limit(1).for("update");
      if (!current) throw new ApiError("Order not found.", 404);
      if (current.status !== body.expectedStatus) throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
      // Marking a delivery order ready hands it straight to the rider. Pickup orders
      // keep the explicit counter handoff, and paired listings stay with Marketplace.
      const autoHandoff = requestedStatus === "ready" && current.fulfilment === "delivery";
      const finalStatus = autoHandoff ? "out_for_delivery" : requestedStatus;
      if (requestedStatus === "out_for_delivery" && current.fulfilment !== "delivery") throw new ApiError("Only delivery orders can be sent out for delivery.", 409);
      if (requestedStatus === "completed" && current.fulfilment === "delivery" && current.status === "ready") throw new ApiError("Send this delivery order out before marking it delivered.", 409);
      const [result] = await tx.update(orders).set({ status: finalStatus, prepMinutes: requestedStatus === "accepted" ? prepMinutes : current.prepMinutes, rejectionReason: requestedStatus === "rejected" ? reason : current.rejectionReason, updatedAt: new Date() }).where(and(eq(orders.id, body.id), eq(orders.businessId, business.id), eq(orders.status, body.expectedStatus), eq(orders.fulfilment, current.fulfilment))).returning();
      if (!result) throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
      await tx.insert(orderEvents).values({ orderId: result.id, actorId: user.id, fromStatus: body.expectedStatus, toStatus: requestedStatus, reason });
      if (autoHandoff) await tx.insert(orderEvents).values({ orderId: result.id, actorId: user.id, fromStatus: "ready", toStatus: "out_for_delivery", reason: "Automatic handoff when marked ready" });
      return result;
    });
    if (updated.status !== "out_for_delivery") return NextResponse.json({ order: updated });
    const dispatchedItems = await db.select({ name: orderItems.name, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, updated.id));
    const dispatch = await dispatchCourierAssignment(request, { ...updated, items: dispatchedItems });
    return NextResponse.json({ order: updated, dispatch });
  } catch (error) { return fail(error, request); }
}
