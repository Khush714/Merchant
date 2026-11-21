import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { orderEvents, orders, paymentAttempts, providerEvents } from "@/db/schema";
import { ApiError } from "@/lib/server";
import {
  confirmCheckout as providerConfirm, createCheckout as providerCreate,
  type CapturedPayment, type CheckoutSession,
} from "@/lib/payment-provider";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Start a local/unpaired checkout. Paired outlets are refused before reaching this service. */
export async function startCheckout(businessId: string, input: { orderId: unknown }): Promise<CheckoutSession & { attemptId: string }> {
  if (typeof input.orderId !== "string" || !uuid.test(input.orderId)) throw new ApiError("Order not found.", 404);
  const [order] = await db.select().from(orders).where(and(eq(orders.id, input.orderId), eq(orders.businessId, businessId))).limit(1);
  if (!order) throw new ApiError("Order not found.", 404);
  if (["completed", "rejected", "cancelled"].includes(order.status)) throw new ApiError("This order is closed and cannot take a payment.", 409);

  const existing = await db.select().from(paymentAttempts).where(and(
    eq(paymentAttempts.businessId, businessId), eq(paymentAttempts.orderId, order.id),
  ));
  const usable = existing.find((row) => ["created", "failed", "authorized"].includes(row.status));
  if (usable?.providerReference && usable.status !== "failed") {
    throw new ApiError("A payment is already in progress for this order. Refresh the payment status instead.", 409);
  }
  const attemptId = usable?.id ?? (await db.insert(paymentAttempts).values({
    businessId, orderId: order.id, provider: "savour", providerReference: "",
    amountPaise: order.total, currency: "INR", status: "created",
  }).returning({ id: paymentAttempts.id }))[0].id;

  const session = await providerCreate({
    businessId, orderNumber: order.orderNumber, attemptId, amountPaise: order.total,
  });
  await db.update(paymentAttempts).set({
    provider: session.mode === "razorpay" ? "razorpay" : "dev",
    providerReference: session.providerOrderId,
    amountPaise: order.total,
    status: "created",
    updatedAt: new Date(),
  }).where(eq(paymentAttempts.id, attemptId));
  return { ...session, attemptId };
}

/** Verify and capture a local checkout, then mark the local attempt paid in one transaction. */
export async function finishCheckout(businessId: string, actorId: string, input: {
  attemptId: unknown;
  providerOrderId: unknown;
  providerPaymentId: unknown;
  signature: unknown;
  devReference: unknown;
}) {
  if (typeof input.attemptId !== "string" || !uuid.test(input.attemptId)) throw new ApiError("Payment attempt not found.", 404);
  const [attempt] = await db.select().from(paymentAttempts).where(and(
    eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.businessId, businessId),
  )).limit(1).for("update");
  if (!attempt) throw new ApiError("Payment attempt not found.", 404);
  if (attempt.status === "paid") return { alreadyConfirmed: true as const, attemptId: attempt.id, notice: "Payment is already confirmed." };
  if (attempt.status === "refunded") throw new ApiError("This payment was already refunded.", 409);
  if (typeof input.providerPaymentId !== "string" || !input.providerPaymentId.trim()) throw new ApiError("Provider payment id is required.");
  const providerOrderId = typeof input.providerOrderId === "string" && input.providerOrderId
    ? input.providerOrderId : attempt.providerReference;
  if (!providerOrderId || (attempt.providerReference && providerOrderId !== attempt.providerReference)) {
    throw new ApiError("This payment result does not belong to the current attempt.", 409);
  }

  const captured: CapturedPayment = await providerConfirm({
    attemptId: attempt.id, providerOrderId,
    providerPaymentId: input.providerPaymentId.trim(),
    signature: typeof input.signature === "string" ? input.signature : "",
    devReference: typeof input.devReference === "string" ? input.devReference : "",
    amountPaise: attempt.amountPaise,
  });

  const at = new Date();
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)).limit(1).for("update");
    if (!current) throw new ApiError("Payment attempt not found.", 404);
    if (current.status === "paid") return { alreadyConfirmed: true as const, attemptId: current.id, notice: "Payment is already confirmed." };
    await tx.update(paymentAttempts).set({
      status: "paid", provider: captured.mode === "razorpay" ? "razorpay" : "dev",
      providerReference: captured.reference, failureCode: "", failureMessage: "",
      lastEventId: `confirm_${attempt.id}`, lastEventAt: at, updatedAt: at,
    }).where(eq(paymentAttempts.id, current.id));
    const [order] = await tx.select().from(orders).where(and(eq(orders.id, current.orderId), eq(orders.businessId, businessId))).limit(1);
    if (order) {
      await tx.update(orders).set({ paymentStatus: "paid", paymentReference: captured.reference, paymentUpdatedAt: at, updatedAt: at })
        .where(eq(orders.id, order.id));
      await tx.insert(orderEvents).values({
        orderId: order.id, actorId, fromStatus: order.status, toStatus: order.status,
        reason: `Payment confirmed via ${captured.mode}`,
      });
    }
    await tx.insert(providerEvents).values({
      businessId, orderId: current.orderId, provider: captured.mode === "razorpay" ? "razorpay" : "merchant",
      eventId: `confirm_${current.id}`, eventType: "paid", outcome: "applied",
      reason: captured.notice, payloadHash: createHash("sha256").update(`${current.id}:${captured.reference}`).digest("hex"),
      occurredAt: at, paymentAttemptId: current.id, amountPaise: current.amountPaise,
    }).onConflictDoNothing();
    return { alreadyConfirmed: false as const, attemptId: current.id, mode: captured.mode, notice: captured.notice };
  });
  return result;
}
