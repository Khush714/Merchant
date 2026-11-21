import { NextRequest, NextResponse } from "next/server";
import { getReconciliationReport, runReconciliation } from "@/lib/reconciliation-service";
import { fail, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Latest persisted order ↔ collection ↔ payout reconciliation report. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    return NextResponse.json(await getReconciliationReport(business.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}

/** Owner-only explicit run. Reports anomalies; never mutates source-of-truth money. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "reconciliation-run", 6);
    const { user, business } = await requireBusiness("finance.write");
    const report = await runReconciliation(business.id, user.id);
    await recordAudit({ request, event: "reconciliation.run", outcome: "success", businessId: business.id, detail: { exceptions: report.exceptions.length } });
    return NextResponse.json(report);
  } catch (error) { return fail(error, request); }
}
