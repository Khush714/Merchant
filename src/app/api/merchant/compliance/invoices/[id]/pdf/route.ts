import { NextRequest, NextResponse } from "next/server";
import { complianceFail } from "@/lib/compliance-api";
import { findInvoice, invoiceDto, invoicePdfContext } from "@/lib/compliance-data";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { ApiError, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Generates a labelled mirror/pro forma PDF from local metadata; it never claims to be the original. */
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const { id } = await params;
    const row = await findInvoice(business.id, id);
    if (!row) throw new ApiError("Invoice not found.", 404);
    const context = await invoicePdfContext(business.id);
    const invoice = invoiceDto(row);
    const pdf = buildInvoicePdf(invoice, context.businessName, context.gstin);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return complianceFail(error, request); }
}
