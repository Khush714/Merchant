import { NextRequest, NextResponse } from "next/server";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { confirmPaymentAttempt } from "@/lib/payment-confirmation";
import { ApiError, fail, rateLimit, readJson, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only manual confirmation of a local payment attempt. Never available for paired outlets. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    await rateLimit(request, "payment-confirm", 20);
    const { user, business } = await requireBusiness("payments.write");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid payment attempt.", 400);
    if (await getMarketplaceLink(business.id)) {
      throw new ApiError("Payments for this outlet are managed by Savour Marketplace.", 409);
    }
    const body = request.body ? await readJson<{ note?: unknown }>(request, 4096) : {};
    const note = typeof body.note === "string" ? body.note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
    const result = await confirmPaymentAttempt(request, {
      businessId: business.id, attemptId: id, actorUserId: user.id, note,
    });
    return NextResponse.json({ confirmed: true, ...result });
  } catch (error) { return fail(error, request); }
}
