import { NextRequest, NextResponse } from "next/server";
import { fail, requireBusiness } from "@/lib/server";
import { loadOverviewData } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { business, role } = await requireBusiness("overview.read");
    const data = await loadOverviewData(business, role, request);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
