import { NextRequest, NextResponse } from "next/server";
import { ApiError, fail, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";
import { syncMarketplaceSettlements } from "@/lib/settlements";

export const dynamic = "force-dynamic";

/** Force a fresh, idempotent pull of authoritative settlement records for the signed-in business. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "settlement-sync", 12);
    const { business } = await requireBusiness("settlements.read");
    try {
      const result = await syncMarketplaceSettlements(business.id, { force: true });
      // Incremental line maintenance happens inside the sync transaction for applied rows.
      const lineCount = result.lineCount;
      await recordAudit({ request, event: "settlement.sync", outcome: "success", businessId: business.id, detail: { source: "manual", received: result.received, applied: result.applied, truncated: result.truncated, lines: lineCount } });
      return NextResponse.json({
        synced: true,
        received: result.received,
        applied: result.applied,
        skipped: result.skipped,
        truncated: result.truncated,
        lineCount,
        lastSyncedAt: result.lastSyncedAt?.toISOString() ?? null,
        ...(result.truncated ? { message: "Showing the newest 2,000 payouts. Older records remain in Marketplace." } : {}),
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      await recordAudit({ request, event: "settlement.sync", outcome: "failure", businessId: business.id, detail: { source: "manual", reason: error instanceof ApiError ? error.message : "sync_failed" } });
      return fail(error, request);
    }
  } catch (error) { return fail(error, request); }
}
