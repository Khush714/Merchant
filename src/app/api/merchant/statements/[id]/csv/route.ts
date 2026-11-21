import { NextRequest } from "next/server";
import { csvDocument, paiseDecimal } from "@/lib/csv";
import { ApiError, fail, requireBusiness } from "@/lib/server";
import { statementDetail } from "@/lib/statements";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Full order-level line item export for one immutable statement. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid statement.", 400);
    const statement = await statementDetail(business.id, id);
    const rows: (string | number)[][] = [[
      "Statement", "Period from", "Period to", "Order", "Gross (INR)", "Commission (INR)",
      "Gateway fee (INR)", "Tax on fees (INR)", "Refund (INR)", "Adjustment (INR)", "Net (INR)", "Source",
    ]];
    for (const line of statement.lines) {
      rows.push([
        statement.number, statement.periodFrom, statement.periodTo, line.orderNumber || line.settlementId,
        paiseDecimal(line.grossPaise), paiseDecimal(line.commissionPaise), paiseDecimal(line.gatewayFeePaise),
        paiseDecimal(line.taxPaise), paiseDecimal(line.refundPaise), paiseDecimal(line.adjustmentPaise),
        paiseDecimal(line.netPaise), line.source,
      ]);
    }
    return new Response(csvDocument(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${statement.number.replace(/[^A-Za-z0-9._-]/g, "_")}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return fail(error, request); }
}
