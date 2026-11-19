import { NextRequest, NextResponse } from "next/server";
import { complianceFail, requestHashes } from "@/lib/compliance-api";
import { acceptCurrentAgreement, loadComplianceOverview } from "@/lib/compliance-data";
import { BODY_LIMITS, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const overview = await loadComplianceOverview(business.id);
    return NextResponse.json({ agreement: overview.compliance.agreement }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}

/** Acceptance is explicit, versioned and append-only; a new version needs a new acceptance. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-agreement", 12);
    const { business, user } = await requireBusiness("compliance.write");
    const input = await readJson(request, BODY_LIMITS.compliance);
    const agreement = await acceptCurrentAgreement(business.id, user.id, input, requestHashes(request));
    await recordAudit({
      request, event: "compliance.agreement_accept", outcome: "success", userId: user.id, businessId: business.id,
      detail: { version: agreement.version, contentHash: agreement.contentHash },
    });
    return NextResponse.json({ agreement }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}
