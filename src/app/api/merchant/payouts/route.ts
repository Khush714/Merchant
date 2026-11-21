import { NextRequest, NextResponse } from "next/server";
import { listPayouts, recordPayout } from "@/lib/payouts";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Payout ledger. Marketplace has no payout feed yet, so local rows are plainly labelled manual. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    return NextResponse.json(await listPayouts(business.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}

/** Owner-only manual payout record, with settlement allocations that must add up to the payout. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "payout-record", 10);
    const { business } = await requireBusiness("finance.write");
    const body = await readJson<{
      reference: unknown; methodLabel?: unknown; status?: unknown; amountPaise: unknown;
      initiatedAt?: unknown; completedAt?: unknown; source?: unknown; allocations: unknown;
    }>(request, 32 * 1024);
    const payout = await recordPayout(business.id, body);
    await recordAudit({ request, event: "payout.record", outcome: "success", businessId: business.id, detail: { payoutId: payout.id, source: payout.source, amountPaise: payout.amountPaise } });
    return NextResponse.json({ payout }, { status: 201 });
  } catch (error) { return fail(error, request); }
}
