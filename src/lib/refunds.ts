import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orderEvents, orders, paymentAttempts, providerEvents, refunds,
} from "@/db/schema";
import { refundPayment } from "@/lib/payment-provider";
import { ApiError } from "@/lib/server";
import type { RefundInbox, RefundRecord } from "@/lib/types";

const OPEN_STATUSES = ["requested", "approved", "processing", "settled"];

function clean(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new ApiError(`${label} is invalid.`);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  if (required && !result) throw new ApiError(`${label} is required.`);
  return result;
}
function paise(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new ApiError("Refund amount must be a positive whole number of paise.");
  return value;
}

function dto(row: typeof refunds.$inferSelect, orderNumber: string, customerName: string): RefundRecord {
  return {
    id: row.id, orderNumber, customerName, amountPaise: row.amountPaise,
    reason: row.reason, status: row.status, providerRefundId: row.providerRefundId,
    note: row.note, createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

export async function listRefunds(businessId: string, canWrite: boolean): Promise<RefundInbox> {
  const rows = await db.select({ refund: refunds, orderNumber: orders.orderNumber, customerName: orders.customerName })
    .from(refunds).innerJoin(orders, eq(refunds.orderId, orders.id))
    .where(eq(refunds.businessId, businessId))
    .orderBy(desc(refunds.createdAt)).limit(200);
  return {
    available: true, notice: "", canWrite,
    refunds: rows.map(({ refund, orderNumber, customerName }) => dto(refund, String(orderNumber), customerName)),
  };
}

/** Create a request only against a confirmed local payment. No gateway call happens here. */
export async function requestRefund(input: {
  businessId: string; actorId: string; orderId?: unknown; orderNumber?: unknown; amountPaise: unknown; reason: unknown;
}) {
  const isUuid = typeof input.orderId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.orderId);
  const orderNumber = Number(input.orderNumber);
  if (!isUuid && !Number.isSafeInteger(orderNumber)) throw new ApiError("Choose a valid order.", 404);
  const amountPaise = paise(input.amountPaise);
  const reason = clean(input.reason, "Reason", 250, true);
  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.businessId, input.businessId),
      isUuid ? eq(orders.id, input.orderId as string) : eq(orders.orderNumber, orderNumber),
    )).limit(1).for("update");
    if (!order) throw new ApiError("Order not found.", 404);
    const attempts = await tx.select().from(paymentAttempts)
      .where(and(eq(paymentAttempts.businessId, input.businessId), eq(paymentAttempts.orderId, order.id)));
    const attempt = attempts.find((row) => row.status === "paid") ?? attempts.find((row) => row.status === "refunded");
    if (!attempt) throw new ApiError("This order has no confirmed local payment to refund.", 409);
    const [total] = await tx.select({ amount: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)::int` })
      .from(refunds).where(sql`${refunds.businessId} = ${input.businessId} and ${refunds.orderId} = ${order.id} and ${refunds.status} in ('requested','approved','processing','settled')`);
    const remaining = attempt.amountPaise - (total?.amount ?? 0);
    if (amountPaise > remaining) throw new ApiError(`Only ${remaining} paise is still refundable on this payment.`, 409);
    const [row] = await tx.insert(refunds).values({
      businessId: input.businessId, orderId: order.id, paymentAttemptId: attempt.id,
      amountPaise, reason, status: "requested", requestedBy: input.actorId,
    }).returning();
    return dto(row, String(order.orderNumber), order.customerName);
  });
  return result;
}

export async function reviewRefund(input: {
  businessId: string; actorId: string; refundId: string; action: "approve" | "reject"; note: string;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.refundId)) throw new ApiError("Refund not found.", 404);
  const [row] = await db.update(refunds).set({
    status: input.action === "approve" ? "approved" : "rejected",
    reviewedBy: input.actorId, note: clean(input.note, "Note", 200), updatedAt: new Date(),
  }).where(and(
    eq(refunds.id, input.refundId), eq(refunds.businessId, input.businessId), eq(refunds.status, "requested"),
  )).returning();
  if (!row) throw new ApiError("Only a pending refund can be reviewed.", 409);
  return { id: row.id, status: row.status };
}

/** Execute an approved refund. Idempotency keys make a retried gateway call safe. */
export async function settleRefund(input: { businessId: string; actorId: string; refundId: string; note: string }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.refundId)) throw new ApiError("Refund not found.", 404);
  const [current] = await db.select().from(refunds).where(and(
    eq(refunds.id, input.refundId), eq(refunds.businessId, input.businessId),
  )).limit(1);
  if (!current) throw new ApiError("Refund not found.", 404);
  if (current.status === "settled") return { id: current.id, status: current.status, providerRefundId: current.providerRefundId };
  if (current.status !== "approved") throw new ApiError("Approve this refund before settling it.", 409);
  const [attempt] = current.paymentAttemptId
    ? await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, current.paymentAttemptId)).limit(1)
    : [];
  if (!attempt?.providerReference) throw new ApiError("This payment has no provider reference. Record the external refund against the order instead.", 409);

  const provider = await refundPayment({
    providerPaymentId: attempt.providerReference, amountPaise: current.amountPaise, refundId: current.id,
  });
  const at = new Date();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(refunds).where(and(
      eq(refunds.id, current.id), eq(refunds.businessId, input.businessId),
    )).limit(1).for("update");
    if (!row) throw new ApiError("Refund not found.", 404);
    if (row.status === "settled") return { id: row.id, status: row.status, providerRefundId: row.providerRefundId };
    if (row.status !== "approved") throw new ApiError("This refund changed on another device.", 409);
    await tx.update(refunds).set({
      status: "settled", providerRefundId: provider.reference,
      note: clean(input.note, "Note", 200) || row.note,
      reviewedBy: input.actorId, settledAt: at, updatedAt: at,
    }).where(eq(refunds.id, row.id));
    if (row.paymentAttemptId) {
      await tx.update(paymentAttempts).set({
        status: "refunded", failureCode: "", failureMessage: "", updatedAt: at,
      }).where(eq(paymentAttempts.id, row.paymentAttemptId));
    }
    const [order] = await tx.select().from(orders).where(and(eq(orders.id, row.orderId), eq(orders.businessId, input.businessId))).limit(1);
    if (order) {
      await tx.update(orders).set({ paymentStatus: "refunded", paymentUpdatedAt: at, updatedAt: at }).where(eq(orders.id, order.id));
      await tx.insert(orderEvents).values({
        orderId: order.id, actorId: input.actorId, fromStatus: order.status, toStatus: order.status,
        reason: `Refund settled (${provider.reference})`,
      });
    }
    await tx.insert(providerEvents).values({
      businessId: input.businessId, orderId: row.orderId, provider: "merchant",
      eventId: `refund_${row.id}`, eventType: "refunded", outcome: "applied",
      reason: provider.notice, payloadHash: `refund:${row.id}:${provider.reference}`,
      occurredAt: at, paymentAttemptId: row.paymentAttemptId, amountPaise: row.amountPaise,
    }).onConflictDoNothing();
    return { id: row.id, status: "settled", providerRefundId: provider.reference };
  });
  return { ...result, mode: provider.mode, notice: provider.notice };
}

/** Signed refund webhooks can settle or create a local refund record without an operator click. */
export async function recordProviderRefund(input: {
  businessId: string;
  orderId: string;
  providerRefundId: string;
  amountPaise: number | null;
  occurredAt: Date;
}) {
  if (!input.providerRefundId) return null;
  const [existing] = await db.select().from(refunds).where(and(
    eq(refunds.businessId, input.businessId), eq(refunds.providerRefundId, input.providerRefundId),
  )).limit(1);
  if (existing) {
    await db.update(refunds).set({ status: "settled", settledAt: input.occurredAt, updatedAt: input.occurredAt })
      .where(eq(refunds.id, existing.id));
    return existing.id;
  }
  const [attempt] = await db.select().from(paymentAttempts).where(and(
    eq(paymentAttempts.businessId, input.businessId), eq(paymentAttempts.orderId, input.orderId),
  )).limit(1);
  const amount = input.amountPaise ?? attempt?.amountPaise ?? 0;
  if (amount <= 0) return null;
  const [row] = await db.insert(refunds).values({
    businessId: input.businessId, orderId: input.orderId, paymentAttemptId: attempt?.id ?? null,
    amountPaise: amount, reason: "Provider refund event", status: "settled",
    providerRefundId: input.providerRefundId, settledAt: input.occurredAt,
  }).onConflictDoNothing().returning();
  return row?.id ?? null;
}

export { OPEN_STATUSES };
