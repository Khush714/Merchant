import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { settlements } from "@/db/schema";
import { csvDocument, csvRow, exportFilename, paiseDecimal } from "@/lib/csv";
import { normalizeRevenueRange } from "@/lib/revenue";
import { loadRevenueSummary } from "@/lib/revenue-data";
import { ApiError, fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Payout mirrors are capped locally; exports expose the same saved history. */
const MAX_SETTLEMENT_ROWS = 5_000;

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Downloadable statements use the same permissions and date range as the on-screen reports. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const params = request.nextUrl.searchParams;
    const type = params.get("type");
    const range = normalizeRevenueRange(params.get("from"), params.get("to"));
    if (!range) throw new ApiError("Choose a valid start and end date.");

    if (type === "revenue") {
      const revenue = await loadRevenueSummary(business.id, range);
      const rows = [
        ["Period", "From", "To", "Gross sales (INR)", "Net paid (INR)", "Completed orders", "Paid settlements", "Currency"],
        [range.from && range.to ? "Custom range" : "All time", revenue.from ?? "", revenue.to ?? "",
          paiseDecimal(revenue.grossSales), paiseDecimal(revenue.netPaid), revenue.completedOrders,
          revenue.paidSettlements, revenue.currency],
      ];
      return csvResponse(csvDocument(rows), exportFilename("revenue", range.from, range.to));
    }

    if (type === "settlements") {
      const effectiveDate = sql`coalesce(${settlements.paidAt}, ${settlements.createdAt})`;
      const filters = [eq(settlements.businessId, business.id)];
      if (range.fromDate) filters.push(sql`${effectiveDate} >= ${range.fromDate}`);
      if (range.toExclusiveDate) filters.push(sql`${effectiveDate} < ${range.toExclusiveDate}`);
      const rows = await db.select().from(settlements)
        .where(and(...filters))
        .orderBy(desc(effectiveDate), desc(settlements.createdAt))
        .limit(MAX_SETTLEMENT_ROWS);

      const csvRows: (string | number)[][] = [[
        "Date", "Order", "Status", "Gross (INR)", "Commission (INR)", "Refund (INR)",
        "Adjustment (INR)", "Net (INR)", "Reference", "Currency",
      ]];
      for (const row of rows) {
        csvRows.push([
          new Date(row.paidAt ?? row.createdAt).toISOString().slice(0, 10),
          row.orderNumber === null ? row.marketplaceOrderId || row.externalId : `SV-${row.orderNumber}`,
          row.status,
          paiseDecimal(row.grossAmount), paiseDecimal(row.commissionAmount), paiseDecimal(row.refundAmount),
          paiseDecimal(row.adjustmentAmount), paiseDecimal(row.netAmount), row.reference, row.currency,
        ]);
      }
      return csvResponse(csvDocument(csvRows), exportFilename("settlements", range.from, range.to));
    }

    throw new ApiError("Choose a report to export.");
  } catch (error) { return fail(error, request); }
}
