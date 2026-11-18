import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orderEvents, orders } from "@/db/schema";
import { MAX_REVIEW_CHARS, feedbackDto, ratingValue } from "@/lib/feedback";
import { ApiError, BODY_LIMITS, fail, rateLimit, readJson, sameOrigin, sha256, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Token-scoped feedback for a completed first-party marketplace order. One review per order, immutable. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "marketplace-feedback", 30);
    const body = await readJson<{ orderId?: unknown; token?: unknown; rating?: unknown; review?: unknown }>(request, BODY_LIMITS.feedback);
    const orderId = textValue(body.orderId, 50), token = textValue(body.token, 128);
    const rating = ratingValue(body.rating), review = textValue(body.review, MAX_REVIEW_CHARS);
    if (!uuid.test(orderId) || token.length < 32 || !/^[a-zA-Z0-9-]+$/.test(token) || rating === null) {
      throw new ApiError("Please check your rating and try again.");
    }

    const result = await db.transaction(async (tx) => {
      // The order is locked so a status change or a second review cannot race this write.
      const [order] = await tx.select().from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.idempotencyHash, sha256(token))))
        .limit(1).for("update");
      if (!order) throw new ApiError("Order not found.", 404);
      if (order.status !== "completed") throw new ApiError("You can rate this order once it is completed.", 409);
      if (order.feedbackAt) return { feedback: feedbackDto(order), alreadySubmitted: true };

      const [updated] = await tx.update(orders).set({ rating, review, feedbackAt: new Date() })
        .where(and(eq(orders.id, order.id), isNull(orders.feedbackAt))).returning();
      if (!updated) {
        const [existing] = await tx.select().from(orders).where(eq(orders.id, order.id)).limit(1);
        return { feedback: feedbackDto(existing), alreadySubmitted: true };
      }
      await tx.insert(orderEvents).values({ orderId: order.id, fromStatus: "completed", toStatus: "completed", reason: "Customer feedback submitted" });
      return { feedback: feedbackDto(updated), alreadySubmitted: false };
    });
    return NextResponse.json(result);
  } catch (error) { return fail(error, request); }
}
