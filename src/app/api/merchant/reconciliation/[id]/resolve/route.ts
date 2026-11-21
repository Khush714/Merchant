import { NextRequest, NextResponse } from "next/server";
import { resolveReconciliationException } from "@/lib/reconciliation-service";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only acknowledgement of an exception with a required resolution note. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    await rateLimit(request, "reconciliation-resolve", 20);
    const { user, business } = await requireBusiness("finance.write");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid exception.", 400);
    const body = await readJson<{ note?: unknown }>(request, 4096);
    const result = await resolveReconciliationException(business.id, user.id, {
      id, note: typeof body.note === "string" ? body.note : "",
    });
    await recordAudit({ request, event: "reconciliation.resolve", outcome: "success", businessId: business.id, detail: { exceptionId: id } });
    return NextResponse.json(result);
  } catch (error) { return fail(error, request); }
}
