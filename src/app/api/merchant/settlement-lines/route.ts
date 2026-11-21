import { NextRequest, NextResponse } from "next/server";
import { listSettlementLines } from "@/lib/settlement-lines";
import { fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Per-settlement gross → net split used by the Earnings waterfall and statement generator. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const lines = await listSettlementLines(business.id);
    return NextResponse.json({ lines, count: lines.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
