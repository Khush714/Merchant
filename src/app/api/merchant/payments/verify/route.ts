import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { finishCheckout } from "@/lib/payment-checkout";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Verify the provider signature, capture and confirm a local checkout in one atomic write. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "payment-verify", 20);
    const { user, business } = await requireBusiness("payments.write");
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Payments for this outlet are managed by Savour Marketplace.", 409);
    }
    const body = await readJson<{
      attemptId?: unknown; providerOrderId?: unknown; providerPaymentId?: unknown;
      signature?: unknown; devReference?: unknown;
    }>(request, 8192);
    const result = await finishCheckout(business.id, user.id, {
      attemptId: body.attemptId,
      providerOrderId: body.providerOrderId,
      providerPaymentId: body.providerPaymentId,
      signature: body.signature,
      devReference: body.devReference,
    });
    await recordAudit({ request, event: "payment.verify", outcome: "success", businessId: business.id, detail: { attemptId: result.attemptId, alreadyConfirmed: result.alreadyConfirmed, mode: "mode" in result ? result.mode : null } });
    return NextResponse.json({ verified: true, ...result });
  } catch (error) { return fail(error, request); }
}
