import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { listRefunds, requestRefund } from "@/lib/refunds";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";
import type { RefundInbox } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Refund inbox. Paired outlets read their authoritative refund state in Marketplace. */
export async function GET(request: NextRequest) {
  try {
    const { business, role } = await requireBusiness("payments.read");
    if (await getMarketplaceLink(business.id)) {
      const paired: RefundInbox = {
        available: false,
        notice: "Refunds for this outlet are issued by Savour Marketplace. Open Marketplace to request or review a refund; nothing here can reverse money.",
        refunds: [], canWrite: false,
      };
      return NextResponse.json(paired);
    }
    return NextResponse.json(await listRefunds(business.id, role === "owner"));
  } catch (error) { return fail(error, request); }
}

/** Create a refund request against a confirmed local payment. No gateway call happens here. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "refund-request", 15);
    const { user, business } = await requireBusiness("payments.refund");
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Refunds for this outlet are issued by Savour Marketplace. Review the refund there.", 409);
    }
    const body = await readJson<{ orderId?: unknown; orderNumber?: unknown; amountPaise?: unknown; reason?: unknown }>(request, 4096);
    const refund = await requestRefund({
      businessId: business.id, actorId: user.id,
      orderId: body.orderId, orderNumber: body.orderNumber,
      amountPaise: body.amountPaise, reason: body.reason,
    });
    await recordAudit({ request, event: "refund.request", outcome: "success", businessId: business.id, detail: { refundId: refund.id, amountPaise: refund.amountPaise } });
    return NextResponse.json({ requested: true, refund }, { status: 201 });
  } catch (error) { return fail(error, request); }
}
