import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, paymentAttempts } from "@/db/schema";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { isPaymentState, PAYMENT_STATES, type PaymentState } from "@/lib/payment-state";
import { ApiError, fail, requireBusiness } from "@/lib/server";
import type { PaymentAttempt, PaymentInbox } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Local payment attempts for the active outlet. Paired outlets stay Marketplace-owned. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("payments.read");
    const emptyCounts = Object.fromEntries(PAYMENT_STATES.map((state) => [state, 0])) as Record<PaymentState, number>;
    if (await getMarketplaceLink(business.id)) {
      const paired: PaymentInbox = {
        available: false,
        notice: "Payments for this outlet are managed by Savour Marketplace. Use the settlement feed for confirmed money, or open Marketplace to review a payment.",
        attempts: [], counts: emptyCounts, truncated: false,
      };
      return NextResponse.json(paired);
    }

    const p = request.nextUrl.searchParams;
    const status = p.get("status") || "all";
    if (status !== "all" && !isPaymentState(status)) throw new ApiError("Invalid payment status.", 400);
    const limit = Math.max(1, Math.min(100, Number(p.get("limit")) || 50));
    const filters = [eq(paymentAttempts.businessId, business.id)];
    if (status !== "all") filters.push(eq(paymentAttempts.status, status));

    const [rows, grouped] = await Promise.all([
      db.select({ attempt: paymentAttempts, orderNumber: orders.orderNumber, customerName: orders.customerName })
        .from(paymentAttempts).innerJoin(orders, eq(paymentAttempts.orderId, orders.id))
        .where(and(...filters)).orderBy(desc(paymentAttempts.createdAt)).limit(limit + 1),
      db.select({ status: paymentAttempts.status, count: sql<number>`count(*)::int` })
        .from(paymentAttempts).where(eq(paymentAttempts.businessId, business.id))
        .groupBy(paymentAttempts.status),
    ]);
    const counts = { ...emptyCounts };
    for (const row of grouped) if (isPaymentState(row.status)) counts[row.status] = row.count;

    const truncated = rows.length > limit;
    const attempts: PaymentAttempt[] = rows.slice(0, limit).map(({ attempt, orderNumber, customerName }) => ({
      id: attempt.id, orderId: attempt.orderId, orderNumber, customerName,
      providerReference: attempt.providerReference, amountPaise: attempt.amountPaise,
      currency: "INR", status: isPaymentState(attempt.status) ? attempt.status : "created",
      failureCode: attempt.failureCode, failureMessage: attempt.failureMessage,
      lastEventAt: attempt.lastEventAt?.toISOString() ?? null,
      createdAt: attempt.createdAt.toISOString(),
    }));
    const payload: PaymentInbox = { available: true, notice: "", attempts, counts, truncated };
    return NextResponse.json(payload);
  } catch (error) { return fail(error, request); }
}
