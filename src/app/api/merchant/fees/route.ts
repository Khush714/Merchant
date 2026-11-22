import { NextRequest, NextResponse } from "next/server";
import { currentFeeSchedule, saveFeeSchedule } from "@/lib/fee-schedules";
import { ApiError, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";
import { maintainSettlementLines } from "@/lib/settlement-lines";

export const dynamic = "force-dynamic";

/** Effective fee schedule for the active outlet (outlet version, else global, else zero-fee default). */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    return NextResponse.json({ schedule: await currentFeeSchedule(business.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}

/** Owner-only versioned fee schedule. Existing statements keep their own immutable totals. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "fee-schedule", 10);
    const { business } = await requireBusiness("finance.write");
    const body = await readJson<Record<string, unknown>>(request, 4096);
    const number = (key: string) => typeof body[key] === "number" ? body[key] as number : Number(body[key]);
    const schedule = await saveFeeSchedule(business.id, {
      commissionBps: number("commissionBps"),
      platformFixedPaise: number("platformFixedPaise"),
      gatewayBps: number("gatewayBps"),
      gatewayFixedPaise: number("gatewayFixedPaise"),
      gstBps: number("gstBps"),
      effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : undefined,
    });
    // A schedule version changes derived gateway/tax splits; rebuild explicitly so reads stay read-only.
    const lineCount = await maintainSettlementLines(business.id, { full: true });
    await recordAudit({
      request, event: "fee-schedule.save", outcome: "success", businessId: business.id,
      detail: { scheduleId: schedule.id, lineCount },
    });
    return NextResponse.json({ schedule, lineCount });
  } catch (error) { return fail(error, request); }
}
