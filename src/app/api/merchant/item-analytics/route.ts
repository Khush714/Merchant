import { NextRequest, NextResponse } from "next/server";
import { loadItemAnalytics } from "@/lib/item-analytics-data";
import { normalizeRevenueRange } from "@/lib/revenue";
import { ApiError, fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Item sales are Marketplace-owned for paired listings; unpaired rows stay local. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const params = request.nextUrl.searchParams;
    const range = normalizeRevenueRange(params.get("from"), params.get("to"));
    if (!range) throw new ApiError("Choose a valid start and end date.");
    const analytics = await loadItemAnalytics(business.id, range);
    return NextResponse.json({ analytics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
