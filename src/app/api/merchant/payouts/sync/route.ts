import { NextRequest, NextResponse } from "next/server";
import { syncPayouts } from "@/lib/payouts";
import { fail, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Try the optional Marketplace payout feed. A missing feed returns an explicit unavailable result. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "payout-sync", 10);
    const { business } = await requireBusiness("finance.write");
    const result = await syncPayouts(business.id);
    await recordAudit({ request, event: "payout.sync", outcome: "success", businessId: business.id, detail: { available: result.available, applied: result.applied } });
    return NextResponse.json({ synced: result.available, ...result });
  } catch (error) { return fail(error, request); }
}
