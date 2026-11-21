import { NextRequest, NextResponse } from "next/server";
import { financeSummary } from "@/lib/statements";
import { fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Gross → net waterfall totals for the active outlet, derived from mirrored settlement lines. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    return NextResponse.json(await financeSummary(business.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
