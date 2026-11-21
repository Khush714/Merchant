import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ApiError, fail, requireBusiness } from "@/lib/server";
import { statementDetail } from "@/lib/statements";
import { buildStatementPdf } from "@/lib/statement-pdf";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Merchant-generated mirror PDF; explicitly not a bank statement or tax invoice. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { business } = await requireBusiness("settlements.read");
    const { id } = await params;
    if (!uuid.test(id)) throw new ApiError("Invalid statement.", 400);
    const [row] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, business.id)).limit(1);
    const statement = await statementDetail(business.id, id);
    const pdf = buildStatementPdf(statement, row?.name ?? "Merchant outlet");
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${statement.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return fail(error, request); }
}
