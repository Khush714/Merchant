import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { startCheckout } from "@/lib/payment-checkout";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Start a local/unpaired checkout. Paired outlets are refused: Marketplace owns their payment. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "payment-checkout", 15);
    const { business } = await requireBusiness("payments.write");
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Payments for this outlet are managed by Savour Marketplace. Open Marketplace to collect this order.", 409);
    }
    const body = await readJson<{ orderId?: unknown }>(request, 4096);
    const session = await startCheckout(business.id, { orderId: body.orderId });
    await recordAudit({ request, event: "payment.checkout", outcome: "success", businessId: business.id, detail: { attemptId: session.attemptId, mode: session.mode } });
    return NextResponse.json(session);
  } catch (error) { return fail(error, request); }
}
