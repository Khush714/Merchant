import { NextRequest, NextResponse } from "next/server";
import { ApiError, fail, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";
import { syncMarketplaceSettlements } from "@/lib/settlements";

export const dynamic = "force-dynamic";

/** Force a fresh, idempotent pull of authoritative settlement records for the signed-in business. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "settlement-sync", 12);
    const { business } = await requireBusiness("integration.write");
    try {
      const result = await syncMarketplaceSettlements(business.id, { force: true });
      await recordAudit({ request, event: "settlement.sync", outcome: "success", businessId: business.id, detail: { source: "manual", received: result.received, applied: result.applied } });
      return NextResponse.json({
        synced: true,
        received: result.received,
        applied: result.applied,
        skipped: result.skipped,
        lastSyncedAt: result.lastSyncedAt?.toISOString() ?? null,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      await recordAudit({ request, event: "settlement.sync", outcome: "failure", businessId: business.id, detail: { source: "manual", reason: error instanceof ApiError ? error.message : "sync_failed" } });
      return fail(error, request);
    }
  } catch (error) { return fail(error, request); }
}
