import { NextRequest, NextResponse } from "next/server";
import { fail, requireBusiness } from "@/lib/server";
import { listSettlementLines } from "@/lib/settlement-lines";

export const dynamic = "force-dynamic";

/** Read-only, keyset-paginated per-settlement gross → net split used by the Earnings waterfall. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const params = request.nextUrl.searchParams;
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    const page = await listSettlementLines(business.id, {
      limit: Number.isFinite(limit) ? limit ?? undefined : undefined,
      cursor: params.get("cursor"),
    });
    return NextResponse.json({
      lines: page.lines,
      count: page.count,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
