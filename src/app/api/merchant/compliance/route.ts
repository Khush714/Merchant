import { NextRequest, NextResponse } from "next/server";
import { complianceFail } from "@/lib/compliance-api";
import { loadComplianceOverview, saveComplianceDetails } from "@/lib/compliance-data";
import { BODY_LIMITS, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Advisory compliance state for the active outlet. Missing items never gate orders or payouts. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const overview = await loadComplianceOverview(business.id);
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}

export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-details", 30);
    const { business, user } = await requireBusiness("compliance.write");
    const input = await readJson(request, BODY_LIMITS.compliance);
    const overview = await saveComplianceDetails(business.id, input);
    await recordAudit({
      request, event: "compliance.details_update", outcome: "success", userId: user.id, businessId: business.id,
      detail: { fields: Object.keys(input).filter((key) => typeof input[key] === "string" || typeof input[key] === "boolean" || typeof input[key] === "number") },
    });
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}
