import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cancellations, orderEvents, orders, paymentAttempts, refunds } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse, parseRemoteOrderMutation } from "@/lib/marketplace-bridge";
import { ApiError } from "@/lib/server";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMarketplace: Record<string, string> = {
  new: "PLACED", accepted: "ACCEPTED", preparing: "PREPARING", ready: "READY",
};
const cancellable = new Set(["new", "accepted", "preparing", "ready"]);

export type CancellationResult = {
  orderId: string;
  status: string;
  refundRequested: boolean;
  notice: string;
};

/** Cancel/reject an order with an explicit reason and an optional linked refund request. */
export async function cancelOrder(input: {
  businessId: string;
  actorId: string;
  orderId: unknown;
  expectedStatus?: unknown;
  nextStatus: unknown;
  reason: unknown;
  refundPaise?: unknown;
}): Promise<CancellationResult> {
  if (typeof input.orderId !== "string" || !uuid.test(input.orderId)) throw new ApiError("Order not found.", 404);
  if (input.nextStatus !== "cancelled" && input.nextStatus !== "rejected") throw new ApiError("Choose cancel or reject.");
  const orderId = input.orderId;
  const nextStatus: "cancelled" | "rejected" = input.nextStatus;
  const reason = typeof input.reason === "string" ? input.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 250) : "";
  if (!reason) throw new ApiError("Give a reason for this cancellation.");
  const refundPaise = input.refundPaise === undefined || input.refundPaise === null || input.refundPaise === ""
    ? 0
    : Number(input.refundPaise);
  if (!Number.isSafeInteger(refundPaise) || refundPaise < 0 || refundPaise > 2_147_483_647) throw new ApiError("Invalid refund amount.");

  if (await getMarketplaceLink(input.businessId)) {
    const expectedStatus = typeof input.expectedStatus === "string" ? input.expectedStatus : "";
    if (!toMarketplace[expectedStatus]) throw new ApiError("The current order status is required for connected outlets.");
    const remote = await marketplaceFetch(input.businessId, "/api/integration/merchant/orders", {
      method: "PATCH",
      body: JSON.stringify({
        orderCode: orderId,
        expectedStatus: toMarketplace[expectedStatus],
        nextStatus: nextStatus === "rejected" ? "REJECTED" : "CANCELLED",
        reason: refundPaise > 0 ? `${reason} (refund request: ${refundPaise} paise)` : reason,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    parseMarketplaceResponse(remote, (payload) => parseRemoteOrderMutation(payload, { id: orderId as string }));
    return {
      orderId, status: nextStatus, refundRequested: false,
      notice: "Cancellation was sent to Savour Marketplace, which owns this order and its payment reversal. Review the refund there.",
    };
  }

  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.businessId, input.businessId))).limit(1).for("update");
    if (!order) throw new ApiError("Order not found.", 404);
    if (!cancellable.has(order.status)) throw new ApiError("This order can no longer be cancelled.", 409);
    if (typeof input.expectedStatus === "string" && input.expectedStatus !== order.status) {
      throw new ApiError("This order changed on another device. Refreshing the latest status.", 409);
    }
    const attempts = await tx.select().from(paymentAttempts).where(and(
      eq(paymentAttempts.businessId, input.businessId), eq(paymentAttempts.orderId, order.id),
    ));
    const paidAttempt = attempts.find((row) => row.status === "paid");
    if (refundPaise > 0 && !paidAttempt) throw new ApiError("This order has no confirmed payment to refund.", 409);
    if (paidAttempt) {
      const [total] = await tx.select({ amount: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)::int` })
        .from(refunds).where(sql`${refunds.businessId} = ${input.businessId} and ${refunds.orderId} = ${order.id} and ${refunds.status} in ('requested','approved','processing','settled')`);
      if (refundPaise > paidAttempt.amountPaise - (total?.amount ?? 0)) throw new ApiError("Refund exceeds the remaining paid amount.", 409);
    }

    await tx.update(orders).set({
      status: nextStatus,
      rejectionReason: nextStatus === "rejected" ? reason : order.rejectionReason,
      updatedAt: new Date(),
    }).where(eq(orders.id, order.id));
    await tx.insert(orderEvents).values({
      orderId: order.id, actorId: input.actorId, fromStatus: order.status,
      toStatus: nextStatus, reason,
    });
    await tx.insert(cancellations).values({
      businessId: input.businessId, orderId: order.id, reason, actorId: input.actorId,
    }).onConflictDoNothing();
    let refundCreated = false;
    if (refundPaise > 0 && paidAttempt) {
      const [refund] = await tx.insert(refunds).values({
        businessId: input.businessId, orderId: order.id, paymentAttemptId: paidAttempt.id,
        amountPaise: refundPaise, reason, status: "requested", requestedBy: input.actorId,
      }).returning();
      await tx.update(cancellations).set({ refundId: refund.id }).where(eq(cancellations.orderId, order.id));
      refundCreated = true;
    }
    return {
      orderId: order.id, status: nextStatus, refundRequested: refundCreated,
      notice: refundCreated
        ? "Order cancelled. A refund request was created for owner approval; no money has moved yet."
        : "Order cancelled. No payment was reversed.",
    };
  });
  return result;
}
