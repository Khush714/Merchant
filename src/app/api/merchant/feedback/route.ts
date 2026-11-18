import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orderEvents, orders } from "@/db/schema";
import { MAX_REVIEW_CHARS, feedbackDto, remoteFeedback } from "@/lib/feedback";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A single, immutable public reply to a customer's order review. */
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request);
    const { user, business } = await requireBusiness("feedback.write");
    const body = await readJson<{ id?: unknown; orderCode?: unknown; response?: unknown }>(request, BODY_LIMITS.feedback);
    const reply = textValue(body.response, MAX_REVIEW_CHARS);
    if (!reply) throw new ApiError("Write a reply before sending it.");

    if (await getMarketplaceLink(business.id)) {
      const orderCode = textValue(body.orderCode ?? body.id, 100);
      if (!orderCode) throw new ApiError("Order not found.", 404);
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/orders/feedback", {
        method: "PATCH",
        body: JSON.stringify({ orderCode, response: reply }),
      });
      return NextResponse.json({ feedback: remoteFeedback(remote.order ?? remote.feedback ?? remote), proxied: true });
    }

    const id = textValue(body.id, 50);
    if (!uuid.test(id)) throw new ApiError("Order not found.", 404);
    const feedback = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders)
        .where(and(eq(orders.id, id), eq(orders.businessId, business.id))).limit(1).for("update");
      if (!order) throw new ApiError("Order not found.", 404);
      if (!order.feedbackAt) throw new ApiError("This order has no customer feedback yet.", 409);
      if (order.merchantResponse) throw new ApiError("You have already replied to this review.", 409);
      const [updated] = await tx.update(orders).set({ merchantResponse: reply, merchantRespondedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.merchantResponse, ""))).returning();
      if (!updated) throw new ApiError("This review was answered on another device. Refresh and try again.", 409);
      await tx.insert(orderEvents).values({ orderId: order.id, actorId: user.id, fromStatus: order.status, toStatus: order.status, reason: "Merchant replied to customer feedback" });
      return feedbackDto(updated);
    });
    return NextResponse.json({ feedback, proxied: false });
  } catch (error) { return fail(error, request); }
}
