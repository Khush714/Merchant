import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orderEvents, orders, paymentAttempts, providerEvents } from "@/db/schema";
import { ApiError, recordAudit } from "@/lib/server";
import type { NextRequest } from "next/server";

const CONFIRMABLE = new Set(["created", "authorized", "failed"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Operator confirmation for an unpaired local attempt (for example an offline settlement that
 * arrived after a failed online attempt). This records money as received; it never calls a gateway.
 */
export async function confirmPaymentAttempt(request: NextRequest, input: {
  businessId: string;
  attemptId: string;
  actorUserId: string;
  note: string;
}) {
  const result = await db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(paymentAttempts).where(and(
      eq(paymentAttempts.id, input.attemptId),
      eq(paymentAttempts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!attempt) throw new ApiError("Payment attempt not found.", 404);
    if (!CONFIRMABLE.has(attempt.status)) {
      throw new ApiError(`A ${attempt.status} payment cannot be confirmed again.`, 409);
    }
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, attempt.orderId), eq(orders.businessId, input.businessId),
    )).limit(1);
    if (!order) throw new ApiError("Order not found.", 404);

    const at = new Date();
    const eventId = `manual_${randomUUID()}`;
    await tx.update(paymentAttempts).set({
      status: "paid", failureCode: "", failureMessage: "",
      lastEventId: eventId, lastEventAt: at, updatedAt: at,
    }).where(eq(paymentAttempts.id, attempt.id));
    await tx.update(orders).set({
      paymentStatus: "paid",
      paymentReference: attempt.providerReference || order.paymentReference,
      paymentUpdatedAt: at, updatedAt: at,
    }).where(eq(orders.id, order.id));
    await tx.insert(orderEvents).values({
      orderId: order.id, fromStatus: order.status, toStatus: order.status,
      reason: "Payment confirmed manually",
    });
    await tx.insert(providerEvents).values({
      businessId: input.businessId, orderId: order.id, provider: "merchant",
      eventId, eventType: "paid", outcome: "applied", reason: input.note,
      payloadHash: hash(`${attempt.id}:${input.actorUserId}:${at.toISOString()}`),
      occurredAt: at, paymentAttemptId: attempt.id, amountPaise: attempt.amountPaise,
    });
    return { id: attempt.id, orderNumber: order.orderNumber, amountPaise: attempt.amountPaise };
  });

  await recordAudit({
    event: "payment.confirmed", outcome: "success", userId: input.actorUserId,
    businessId: input.businessId, detail: { attemptId: input.attemptId, orderNumber: result.orderNumber, amountPaise: result.amountPaise },
  });
  return result;
}
