import { NextRequest, NextResponse } from "next/server";
import { complianceFail } from "@/lib/compliance-api";
import { loadPayoutView, submitPayoutDetails } from "@/lib/compliance-data";
import { BODY_LIMITS, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Marketplace remains authoritative; local state is only a masked, labelled mirror. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const payout = await loadPayoutView(business.id);
    return NextResponse.json({ payout }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-payout", 12);
    const { business, user } = await requireBusiness("compliance.write");
    const input = await readJson(request, BODY_LIMITS.compliance);
    const payout = await submitPayoutDetails(business.id, input);
    await recordAudit({
      request, event: "compliance.payout_update", outcome: "success", userId: user.id, businessId: business.id,
      // The raw account number/UPI ID is forwarded only to Marketplace and is never logged here.
      detail: { method: input.method === "upi" ? "upi" : input.method === "bank" ? "bank" : "unknown", status: payout.status },
    });
    return NextResponse.json({ payout }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}
