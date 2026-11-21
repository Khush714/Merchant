import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { reviewRefund } from "@/lib/refunds";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only approve/reject of a pending refund request. Still moves no money. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    await rateLimit(request, "refund-review", 20);
    const { user, business } = await requireBusiness("payments.refund");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid refund.", 400);
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Refunds for this outlet are issued by Savour Marketplace.", 409);
    }
    const body = await readJson<{ action?: unknown; note?: unknown }>(request, 4096);
    if (body.action !== "approve" && body.action !== "reject") throw new ApiError("Choose approve or reject.");
    const result = await reviewRefund({
      businessId: business.id, actorId: user.id, refundId: id,
      action: body.action, note: typeof body.note === "string" ? body.note : "",
    });
    await recordAudit({ request, event: "refund.review", outcome: "success", businessId: business.id, detail: { refundId: id, status: result.status } });
    return NextResponse.json(result);
  } catch (error) { return fail(error, request); }
}
