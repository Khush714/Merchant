import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { settleRefund } from "@/lib/refunds";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only execution of an approved refund. Idempotent; paired outlets are refused. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    await rateLimit(request, "refund-settle", 10);
    const { user, business } = await requireBusiness("payments.refund");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid refund.", 400);
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Refunds for this outlet are issued by Savour Marketplace.", 409);
    }
    const body = request.body ? await readJson<{ note?: unknown }>(request, 4096) : {};
    const result = await settleRefund({
      businessId: business.id, actorId: user.id, refundId: id,
      note: typeof body.note === "string" ? body.note : "",
    });
    await recordAudit({ request, event: "refund.settle", outcome: "success", businessId: business.id, detail: { refundId: id, mode: "mode" in result ? result.mode : null } });
    return NextResponse.json(result);
  } catch (error) { return fail(error, request); }
}
