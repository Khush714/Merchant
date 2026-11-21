import { NextRequest, NextResponse } from "next/server";
import { cancelOrder } from "@/lib/order-cancellation";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cancel/reject an order with a reason and an optional refund request. Paired outlets stay upstream. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    await rateLimit(request, "order-cancel", 15);
    const { user, business } = await requireBusiness("orders.write");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Order not found.", 404);
    const body = await readJson<{ expectedStatus?: unknown; nextStatus?: unknown; reason?: unknown; refundPaise?: unknown }>(request, 4096);
    const result = await cancelOrder({
      businessId: business.id, actorId: user.id, orderId: id,
      expectedStatus: body.expectedStatus, nextStatus: body.nextStatus,
      reason: body.reason, refundPaise: body.refundPaise,
    });
    await recordAudit({ request, event: "order.cancel", outcome: "success", businessId: business.id, detail: { orderId: id, status: result.status, refundRequested: result.refundRequested } });
    return NextResponse.json(result);
  } catch (error) { return fail(error, request); }
}
