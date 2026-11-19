import { NextRequest, NextResponse } from "next/server";
import { loadRevenueSummary } from "@/lib/revenue-data";
import { normalizeRevenueRange } from "@/lib/revenue";
import { ApiError, fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Revenue is Marketplace-owned for paired listings; unpaired rows stay local. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const params = request.nextUrl.searchParams;
    const range = normalizeRevenueRange(params.get("from"), params.get("to"));
    if (!range) throw new ApiError("Choose a valid start and end date.");
    const revenue = await loadRevenueSummary(business.id, range);
    return NextResponse.json({ revenue }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
