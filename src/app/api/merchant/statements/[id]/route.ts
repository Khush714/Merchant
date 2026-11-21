import { NextRequest, NextResponse } from "next/server";
import { ApiError, fail, requireBusiness } from "@/lib/server";
import { statementDetail } from "@/lib/statements";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid statement.", 400);
    return NextResponse.json({ statement: await statementDetail(business.id, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
