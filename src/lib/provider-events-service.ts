import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orderEvents, orders, providerEvents } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import {
  type CourierEventType, type ParsedProviderEvent, type PaymentEventType, type ProviderKind,
} from "@/lib/provider-events";
import { ApiError, recordAudit } from "@/lib/server";
import type { NextRequest } from "next/server";

const COURIER_STATUS: Record<CourierEventType, string> = {
  assigned: "assigned", picked_up: "picked_up", out_for_delivery: "out_for_delivery", delivered: "delivered", failed: "failed",
};
const PAYMENT_STATUS: Record<PaymentEventType, string> = {
  authorized: "authorized", paid: "paid", failed: "failed", refunded: "refunded",
};

export type ProviderEventResult = {
  outcome: "applied" | "duplicate" | "ignored";
  reason: string;
  orderId: string;
  status: string;
  courierStatus: string;
  paymentStatus: string;
};

/** Apply a verified provider event in one transaction. Retrying the same event id is a no-op. */
export async function applyProviderEvent(request: NextRequest, event: ParsedProviderEvent, payloadHash: string): Promise<ProviderEventResult> {
  // Paired listings are owned by Marketplace; writing provider state here would fork reality.
  if (await getMarketplaceLink(event.businessId)) {
    throw new ApiError("This business is connected to Savour Marketplace, which owns its order state. Send provider events there.", 409);
  }
  const result = await db.transaction(async (tx): Promise<ProviderEventResult> => {
    const match = event.orderId
      ? and(eq(orders.id, event.orderId), eq(orders.businessId, event.businessId))
      : and(eq(orders.orderNumber, event.orderCode!), eq(orders.businessId, event.businessId));
    const [current] = await tx.select().from(orders).where(match).limit(1).for("update");
    if (!current) throw new ApiError("Order not found.", 404);

    const base = { orderId: current.id, status: current.status, courierStatus: current.courierStatus, paymentStatus: current.paymentStatus };
    let inserted: { id: string };
    try {
      [inserted] = await tx.insert(providerEvents).values({
        businessId: event.businessId, orderId: current.id, provider: event.provider,
        eventId: event.eventId, eventType: event.type, payloadHash,
        occurredAt: new Date(event.occurredAt),
      }).returning({ id: providerEvents.id });
    } catch (error) {
      if (isUniqueViolation(error)) return { ...base, outcome: "duplicate", reason: "Event already received." };
      throw error;
    }

    const lastAt = event.provider === "courier" ? current.courierUpdatedAt : current.paymentUpdatedAt;
    if (lastAt && Date.parse(event.occurredAt) <= lastAt.getTime()) {
      await tx.update(providerEvents).set({ outcome: "ignored", reason: "Older event than the current provider state." }).where(eq(providerEvents.id, inserted.id));
      return { ...base, outcome: "ignored", reason: "Older event than the current provider state." };
    }

    const occurredAt = new Date(event.occurredAt);
    if (event.provider === "courier") {
      const type = event.type as CourierEventType;
      const closed = ["completed", "rejected", "cancelled"].includes(current.status);
      if (type !== "failed" && current.fulfilment !== "delivery") {
        await tx.update(providerEvents).set({ outcome: "ignored", reason: "Courier events only apply to delivery orders." }).where(eq(providerEvents.id, inserted.id));
        return { ...base, outcome: "ignored", reason: "Courier events only apply to delivery orders." };
      }
      let nextStatus = current.status;
      let ignoreReason = "";
      if (closed) ignoreReason = "Order is already closed.";
      else if (type === "out_for_delivery") {
        if (["accepted", "preparing", "ready"].includes(current.status)) nextStatus = "out_for_delivery";
        else ignoreReason = "Order is not ready for dispatch.";
      } else if (type === "delivered") {
        if (["ready", "out_for_delivery"].includes(current.status)) nextStatus = "completed";
        else ignoreReason = "Order is not ready for delivery completion.";
      }
      if (ignoreReason) {
        await tx.update(providerEvents).set({ outcome: "ignored", reason: ignoreReason }).where(eq(providerEvents.id, inserted.id));
        return { ...base, outcome: "ignored", reason: ignoreReason };
      }
      const [updated] = await tx.update(orders).set({
        status: nextStatus, courierStatus: COURIER_STATUS[type],
        courierTrackingId: event.trackingId || current.courierTrackingId,
        courierUpdatedAt: occurredAt, updatedAt: new Date(),
      }).where(eq(orders.id, current.id)).returning();
      await tx.insert(orderEvents).values({
        orderId: current.id, fromStatus: current.status, toStatus: updated.status,
        reason: `Courier ${type.replaceAll("_", " ")} via webhook`,
      });
      return { outcome: "applied", reason: "", orderId: current.id, status: updated.status, courierStatus: updated.courierStatus, paymentStatus: current.paymentStatus };
    }

    const type = event.type as PaymentEventType;
    const [updated] = await tx.update(orders).set({
      paymentStatus: PAYMENT_STATUS[type],
      paymentReference: event.reference || current.paymentReference,
      paymentUpdatedAt: occurredAt, updatedAt: new Date(),
    }).where(eq(orders.id, current.id)).returning();
    await tx.insert(orderEvents).values({
      orderId: current.id, fromStatus: current.status, toStatus: current.status,
      reason: `Payment ${type} via webhook`,
    });
    return { outcome: "applied", reason: "", orderId: current.id, status: current.status, courierStatus: current.courierStatus, paymentStatus: updated.paymentStatus };
  });

  await recordAudit({
    request, event: `provider_event.${event.provider}`, outcome: "success", businessId: event.businessId,
    detail: { eventId: event.eventId, type: event.type, orderId: result.orderId, outcome: result.outcome },
  });
  return result;
}
